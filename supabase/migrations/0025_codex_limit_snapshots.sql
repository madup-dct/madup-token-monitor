-- 0025_codex_limit_snapshots.sql: Codex 계정 한도 스냅샷 공유
--
-- Codex account_id 는 UUID 형식이 계약상 보장되지 않으므로 Claude의 uuid 키 테이블과
-- 분리한다. 인증 토큰은 저장하지 않고, 로컬 auth.json 에서 추출한 계정 메타데이터와
-- 정규화된 한도 창만 저장한다.

create table if not exists codex_limit_snapshots (
  account_id    text primary key,
  account_email text,
  plan_type     text,
  windows       jsonb not null,
  fetched_at    timestamptz not null,
  uploaded_by   uuid not null references profiles(id),
  updated_at    timestamptz not null default now(),
  constraint codex_limit_snapshots_account_id_nonempty check (length(trim(account_id)) > 0),
  constraint codex_limit_snapshots_windows_array check (jsonb_typeof(windows) = 'array')
);

alter table codex_limit_snapshots enable row level security;

create table if not exists codex_owner (
  account_id  text primary key,
  owner_email text not null
);

alter table codex_owner enable row level security;

-- 계정 목록은 팀 범위 RPC로만 읽는다. 0023의 broad SELECT 정책은 0024 RPC의
-- 팀 필터를 우회하므로 함께 제거한다.
drop policy if exists "authenticated read snapshots" on claude_limit_snapshots;
drop policy if exists "authenticated read owner" on claude_owner;
revoke select on claude_limit_snapshots from authenticated;
revoke select on claude_owner from authenticated;
revoke all on codex_limit_snapshots from authenticated;
revoke all on codex_owner from authenticated;
revoke create on schema public from public, anon, authenticated;

create or replace function upsert_codex_limit_snapshot(
  p_account_id text,
  p_account_email text,
  p_plan_type text,
  p_windows jsonb,
  p_fetched_at timestamptz
) returns void
language plpgsql security definer set search_path = pg_catalog as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if p_account_id is null or length(trim(p_account_id)) = 0 then
    raise exception 'account_id is required';
  end if;
  if length(p_account_id) > 256
     or length(coalesce(p_account_email, '')) > 320
     or length(coalesce(p_plan_type, '')) > 64 then
    raise exception 'account metadata is too long';
  end if;
  if p_fetched_at is null or p_fetched_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'invalid fetched_at';
  end if;
  if jsonb_typeof(p_windows) is distinct from 'array'
     or jsonb_array_length(p_windows) = 0
     or jsonb_array_length(p_windows) > 16
     or pg_column_size(p_windows) > 65536 then
    raise exception 'windows must be a non-empty array';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_windows) as item
    where jsonb_typeof(item) is distinct from 'object'
       or jsonb_typeof(item -> 'kind') is distinct from 'string'
       or length(item ->> 'kind') > 64
       or jsonb_typeof(item -> 'utilization') is distinct from 'number'
       or (item ->> 'utilization')::numeric not between 0 and 100
       or jsonb_typeof(item -> 'resets_at') is distinct from 'string'
       or length(item ->> 'resets_at') > 64
       or (item ? 'scope_model' and jsonb_typeof(item -> 'scope_model') not in ('string', 'null'))
       or length(coalesce(item ->> 'scope_model', '')) > 128
  ) then
    raise exception 'invalid window';
  end if;
  if exists (
    select 1
    from public.codex_limit_snapshots s
    left join public.codex_owner o on o.account_id = s.account_id
    left join lateral (
      select pr.id
      from public.profiles pr
      where pr.email = o.owner_email
      order by pr.created_at asc, pr.id asc
      limit 1
    ) owner_profile on true
    where s.account_id = p_account_id
      and not (
        public.is_team_leader_or_above()
        or s.uploaded_by = auth.uid()
        or (o.account_id is null and public.are_team_mates(auth.uid(), s.uploaded_by))
        or owner_profile.id = auth.uid()
        or public.are_team_mates(auth.uid(), owner_profile.id)
      )
  ) then
    raise exception 'not authorized for account';
  end if;

  insert into public.codex_limit_snapshots
    (account_id, account_email, plan_type, windows, fetched_at, uploaded_by, updated_at)
  values
    (p_account_id, nullif(trim(p_account_email), ''), p_plan_type, p_windows,
     p_fetched_at, auth.uid(), now())
  on conflict (account_id) do update
    set plan_type     = excluded.plan_type,
        windows       = excluded.windows,
        fetched_at    = excluded.fetched_at,
        updated_at    = now()
    where excluded.fetched_at > public.codex_limit_snapshots.fetched_at;
end $$;

revoke all on function upsert_codex_limit_snapshot(text, text, text, jsonb, timestamptz) from public;
grant execute on function upsert_codex_limit_snapshot(text, text, text, jsonb, timestamptz) to authenticated;

create or replace function get_codex_account_limits()
returns table (
  account_id text,
  account_email text,
  owner_email text,
  owner_name text,
  plan_type text,
  windows jsonb,
  fetched_at timestamptz,
  updated_at timestamptz
)
language sql stable security definer set search_path = pg_catalog as $$
  select
    s.account_id,
    coalesce(s.account_email, uploader.email, s.account_id) as account_email,
    coalesce(o.owner_email, uploader.email, s.account_id) as owner_email,
    coalesce(owner_profile.name, uploader.name) as owner_name,
    s.plan_type,
    s.windows,
    s.fetched_at,
    s.updated_at
  from public.codex_limit_snapshots s
  join public.profiles uploader on uploader.id = s.uploaded_by
  left join public.codex_owner o on o.account_id = s.account_id
  left join lateral (
    select pr.id, pr.name
    from public.profiles pr
    where pr.email = o.owner_email
    order by pr.created_at asc, pr.id asc
    limit 1
  ) owner_profile on true
  where
    public.is_team_leader_or_above()
    or s.uploaded_by = auth.uid()
    or (o.account_id is null and public.are_team_mates(auth.uid(), s.uploaded_by))
    or owner_profile.id = auth.uid()
    or public.are_team_mates(auth.uid(), owner_profile.id)
$$;

revoke all on function get_codex_account_limits() from public;
grant execute on function get_codex_account_limits() to authenticated;
