-- 0023_claude_limit_snapshots.sql: 계정별 Claude 한도 스냅샷 공유 + 소유자 매핑
--
-- 배경: 팀이 같은 Claude 계정을 여러 명이 나눠 쓰고 기기의 로그인 계정도 수시로 바뀐다.
--   한도의 주체는 앱 유저(profile)가 아니라 Claude 계정 — 스냅샷 키 = oauthAccount.accountUuid.
--   같은 계정 row 를 여러 유저가 갱신해야 하므로 row 소유 RLS 대신 security definer RPC 경유.
--   업로드는 동의 토글 없이 전원 (2026-07-13 기획 확정 — 사내 도구, 쉐어 요청 유스케이스 전제).
--
-- windows jsonb 형식: [{"kind":"session","scope_model":null,"utilization":59.0,
--                       "resets_at":"2026-07-13T13:50:00+00:00"}, ...]

create table if not exists claude_limit_snapshots (
  account_uuid  uuid primary key,          -- ~/.claude.json oauthAccount.accountUuid
  account_email text not null,             -- oauthAccount.emailAddress
  windows       jsonb not null,
  fetched_at    timestamptz not null,      -- 클라이언트가 usage API 를 fetch 한 시각
  uploaded_by   uuid references profiles(id),
  updated_at    timestamptz not null default now()
);

alter table claude_limit_snapshots enable row level security;

drop policy if exists "authenticated read snapshots" on claude_limit_snapshots;
create policy "authenticated read snapshots"
  on claude_limit_snapshots for select to authenticated using (true);

-- 계정 → 소유자 수동 매핑 (공용/개인 이메일 계정 예외용).
-- v1 은 관리 UI 없음 — Supabase 직접 INSERT 로 운영 (스펙 §4.2).
create table if not exists claude_owner (
  account_email text primary key,
  owner_email   text not null
);

alter table claude_owner enable row level security;

drop policy if exists "authenticated read owner" on claude_owner;
create policy "authenticated read owner"
  on claude_owner for select to authenticated using (true);

-- 업로드 RPC — 오래된 fetched_at 이 최신 스냅샷을 덮지 않도록 가드.
create or replace function upsert_claude_limit_snapshot(
  p_account_uuid uuid,
  p_account_email text,
  p_windows jsonb,
  p_fetched_at timestamptz
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  insert into claude_limit_snapshots
    (account_uuid, account_email, windows, fetched_at, uploaded_by, updated_at)
  values
    (p_account_uuid, p_account_email, p_windows, p_fetched_at, auth.uid(), now())
  on conflict (account_uuid) do update
    set account_email = excluded.account_email,
        windows       = excluded.windows,
        fetched_at    = excluded.fetched_at,
        uploaded_by   = excluded.uploaded_by,
        updated_at    = now()
    where excluded.fetched_at >= claude_limit_snapshots.fetched_at;
end $$;

revoke all on function upsert_claude_limit_snapshot(uuid, text, jsonb, timestamptz) from public;
grant execute on function upsert_claude_limit_snapshot(uuid, text, jsonb, timestamptz) to authenticated;

-- 열람 RPC — 소유자 결정 규칙: claude_owner 매핑 → 계정 이메일 그대로.
-- 표시명은 결정된 owner_email 과 일치하는 profile 의 name (없으면 null → 프론트가 이메일 표시).
create or replace function get_claude_account_limits()
returns table (
  account_uuid uuid,
  account_email text,
  owner_email text,
  owner_name text,
  windows jsonb,
  fetched_at timestamptz,
  updated_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select
    s.account_uuid,
    s.account_email,
    coalesce(o.owner_email, s.account_email) as owner_email,
    p.name as owner_name,
    s.windows,
    s.fetched_at,
    s.updated_at
  from claude_limit_snapshots s
  left join claude_owner o on o.account_email = s.account_email
  left join profiles p on p.email = coalesce(o.owner_email, s.account_email)
$$;

revoke all on function get_claude_account_limits() from public;
grant execute on function get_claude_account_limits() to authenticated;
