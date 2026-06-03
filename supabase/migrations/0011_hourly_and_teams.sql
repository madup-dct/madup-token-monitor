-- 0011_hourly_and_teams.sql: 시간별 집계 + 팀/권한
--
-- 플랜: docs/PLAN-hourly-and-teams.md (§2~§3)
--
-- 변경 요약:
--   1) usage_hourly 신규 테이블 (UTC hour 버킷, 분 단위는 로컬 SQLite에만)
--   2) teams / team_members / app_roles 신규 테이블
--   3) RLS 헬퍼 (security definer) — 재귀 RLS 회피 + 성능
--   4) 팀 생성 시 owner 자동 등록 트리거
--   5) 신규 테이블 RLS 정책 (본인 / 팀메이트 / 어드민)
--   6) 기존 테이블 RLS 보강 — usage_aggregates / mcp_usage / plugin_usage / profiles
--      에 "팀메이트 조회" + "어드민 전체 조회" 정책 추가.
--
-- 적용 후 검증:
--   - select * from teams;  -- 정책 적용 후 빈 결과 (가입 전)
--   - insert into teams (name, slug, created_by) values ('test', 'test', auth.uid());
--     → 트리거로 team_members 에 owner 자동 등록되어야 함.

-- ============================================================
-- 1) 시간별 집계
-- ============================================================
-- 컬럼명은 기존 일별 테이블(usage_aggregates) 및 SQLite usage_events 와
-- 일관성을 위해 input_tokens/output_tokens/cache_read/cache_write 로.
-- PK 에 model 포함 — claude/codex/gemini 외 모델별 분해 가능.
-- 모델 정보가 없는 이벤트는 model = '' (빈 문자열) 로 적재.
create table usage_hourly (
  user_id        uuid not null references profiles(id) on delete cascade,
  hour_utc       timestamptz not null,
  source         text not null,
  model          text not null default '',
  input_tokens   bigint not null default 0,
  output_tokens  bigint not null default 0,
  cache_read     bigint not null default 0,
  cache_write    bigint not null default 0,
  cost_usd       numeric(12, 6) not null default 0,
  request_count  int not null default 0,
  primary key (user_id, hour_utc, source, model)
);
create index idx_usage_hourly_hour      on usage_hourly (hour_utc desc);
create index idx_usage_hourly_user_hour on usage_hourly (user_id, hour_utc desc);

-- ============================================================
-- 2) 팀
-- ============================================================
create table teams (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text unique not null,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now()
);

create table team_members (
  team_id    uuid not null references teams(id) on delete cascade,
  user_id    uuid not null references profiles(id) on delete cascade,
  role       text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at  timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index idx_team_members_user on team_members(user_id);

-- ============================================================
-- 3) 전역 역할 (서비스 어드민)
-- ============================================================
create table app_roles (
  user_id    uuid primary key references profiles(id) on delete cascade,
  role       text not null check (role in ('admin', 'user')),
  created_at timestamptz not null default now()
);

-- ============================================================
-- 4) RLS 헬퍼 (security definer — 재귀 RLS 회피 + 성능)
-- ============================================================
-- 정책 안에서 team_members 를 SELECT 하면 자기 자신에 대한 RLS 가 재귀로 평가되어
-- "infinite recursion detected in policy" 에러가 난다. security definer 함수로 우회.

create or replace function is_app_admin()
returns boolean
language sql stable security definer
set search_path = public as $$
  select exists (
    select 1 from app_roles
    where user_id = auth.uid() and role = 'admin'
  );
$$;

create or replace function is_team_member(p_team_id uuid)
returns boolean
language sql stable security definer
set search_path = public as $$
  select exists (
    select 1 from team_members
    where team_id = p_team_id and user_id = auth.uid()
  );
$$;

create or replace function is_team_admin(p_team_id uuid)
returns boolean
language sql stable security definer
set search_path = public as $$
  select exists (
    select 1 from team_members
    where team_id = p_team_id
      and user_id = auth.uid()
      and role in ('owner', 'admin')
  );
$$;

-- 두 사용자가 같은 팀에 속해 있는지. usage_hourly / usage_aggregates / mcp_usage /
-- plugin_usage / profiles 의 "팀메이트 조회" 정책에서 공통 사용.
create or replace function are_team_mates(p_user_a uuid, p_user_b uuid)
returns boolean
language sql stable security definer
set search_path = public as $$
  select exists (
    select 1
    from team_members tm1
    join team_members tm2 on tm1.team_id = tm2.team_id
    where tm1.user_id = p_user_a
      and tm2.user_id = p_user_b
  );
$$;

-- ============================================================
-- 5) 팀 생성 시 owner 자동 등록 트리거
-- ============================================================
-- teams INSERT 정책은 created_by = auth.uid() 만 허용. 트리거가 security definer 로
-- team_members RLS 를 우회하여 owner row 를 추가.
create or replace function on_team_inserted()
returns trigger
language plpgsql security definer
set search_path = public as $$
begin
  insert into team_members (team_id, user_id, role)
  values (new.id, new.created_by, 'owner');
  return new;
end;
$$;

create trigger teams_after_insert
  after insert on teams
  for each row execute function on_team_inserted();

-- ============================================================
-- 6) RLS — usage_hourly
-- ============================================================
alter table usage_hourly enable row level security;

create policy "usage_hourly: 본인 row 조회"
  on usage_hourly for select
  using (auth.uid() = user_id);

create policy "usage_hourly: 본인만 삽입"
  on usage_hourly for insert
  with check (auth.uid() = user_id);

create policy "usage_hourly: 본인만 수정"
  on usage_hourly for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "usage_hourly: 팀메이트 조회"
  on usage_hourly for select
  using (
    are_team_mates(auth.uid(), user_id)
    and exists (
      select 1 from profiles p
      where p.id = usage_hourly.user_id and p.share_consent = true
    )
  );

create policy "usage_hourly: 어드민 전체 조회"
  on usage_hourly for select
  using (is_app_admin());

-- ============================================================
-- 7) RLS — teams
-- ============================================================
alter table teams enable row level security;

create policy "teams: 가입한 팀 조회"
  on teams for select
  using (is_team_member(id));

create policy "teams: 어드민 전체 조회"
  on teams for select
  using (is_app_admin());

-- 누구나 팀 생성 가능. 단, created_by 는 본인이어야 함.
create policy "teams: 누구나 생성"
  on teams for insert
  with check (created_by = auth.uid());

create policy "teams: owner만 수정"
  on teams for update
  using (
    exists (
      select 1 from team_members
      where team_id = teams.id
        and user_id = auth.uid()
        and role = 'owner'
    )
  );

create policy "teams: owner만 삭제"
  on teams for delete
  using (
    exists (
      select 1 from team_members
      where team_id = teams.id
        and user_id = auth.uid()
        and role = 'owner'
    )
  );

-- ============================================================
-- 8) RLS — team_members
-- ============================================================
alter table team_members enable row level security;

create policy "team_members: 같은 팀 멤버 조회"
  on team_members for select
  using (is_team_member(team_id));

create policy "team_members: 어드민 전체 조회"
  on team_members for select
  using (is_app_admin());

-- owner/admin 만 초대. 트리거에서 owner 자동 등록은 security definer 로 우회.
create policy "team_members: owner/admin 초대"
  on team_members for insert
  with check (is_team_admin(team_id));

create policy "team_members: owner/admin 권한 변경"
  on team_members for update
  using (is_team_admin(team_id))
  with check (is_team_admin(team_id));

-- 본인 leave 또는 owner/admin 의 강퇴
create policy "team_members: leave 또는 강퇴"
  on team_members for delete
  using (
    user_id = auth.uid()
    or is_team_admin(team_id)
  );

-- ============================================================
-- 9) RLS — app_roles
-- ============================================================
alter table app_roles enable row level security;

create policy "app_roles: 본인 조회"
  on app_roles for select
  using (user_id = auth.uid());

create policy "app_roles: 어드민 전체 조회"
  on app_roles for select
  using (is_app_admin());

-- INSERT/UPDATE/DELETE 는 어드민만. 최초 어드민은 Supabase Studio 에서 직접 INSERT 로 부트스트랩.
create policy "app_roles: 어드민만 변경 (insert)"
  on app_roles for insert
  with check (is_app_admin());

create policy "app_roles: 어드민만 변경 (update)"
  on app_roles for update
  using (is_app_admin())
  with check (is_app_admin());

create policy "app_roles: 어드민만 변경 (delete)"
  on app_roles for delete
  using (is_app_admin());

-- ============================================================
-- 10) 기존 테이블 RLS 보강 — 팀메이트 + 어드민 SELECT 추가
-- ============================================================
-- 기존 "본인 row select" 정책은 그대로 유지. PostgreSQL 의 정책은 OR 결합이므로
-- 정책 추가는 권한 확대(허용 케이스 추가) 방향이며 기존 흐름을 깨지 않는다.

-- profiles
create policy "profiles: 팀메이트 조회"
  on profiles for select
  using (are_team_mates(auth.uid(), id));

create policy "profiles: 어드민 전체 조회"
  on profiles for select
  using (is_app_admin());

-- usage_aggregates
create policy "usage_aggregates: 팀메이트 조회"
  on usage_aggregates for select
  using (
    are_team_mates(auth.uid(), user_id)
    and exists (
      select 1 from profiles p
      where p.id = usage_aggregates.user_id and p.share_consent = true
    )
  );

create policy "usage_aggregates: 어드민 전체 조회"
  on usage_aggregates for select
  using (is_app_admin());

-- mcp_usage
create policy "mcp_usage: 팀메이트 조회"
  on mcp_usage for select
  using (
    are_team_mates(auth.uid(), user_id)
    and exists (
      select 1 from profiles p
      where p.id = mcp_usage.user_id and p.share_consent = true
    )
  );

create policy "mcp_usage: 어드민 전체 조회"
  on mcp_usage for select
  using (is_app_admin());

-- plugin_usage
create policy "plugin_usage: 팀메이트 조회"
  on plugin_usage for select
  using (
    are_team_mates(auth.uid(), user_id)
    and exists (
      select 1 from profiles p
      where p.id = plugin_usage.user_id and p.share_consent = true
    )
  );

create policy "plugin_usage: 어드민 전체 조회"
  on plugin_usage for select
  using (is_app_admin());
