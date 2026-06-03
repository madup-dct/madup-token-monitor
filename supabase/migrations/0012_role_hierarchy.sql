-- 0012_role_hierarchy.sql: 4단계 권한 모델 + 권한별 RPC
--
-- 플랜: .omc/plans/role-based-insights.md
-- 선행: 0011_hourly_and_teams.sql 가 먼저 적용되어 있어야 함.
--
-- 변경 요약:
--   1) app_roles.role 체크 제약 확장: user|team_leader|manager|admin
--   2) RLS 헬퍼 추가: is_admin_only / is_manager_or_above / is_team_leader_or_above
--      (기존 is_app_admin 은 "admin 만" 의미로 호환 유지 — alias)
--   3) 0011 의 "어드민 전체 조회" 정책들을 의미상 manager+ 로 격상
--      (drop + recreate 로 명시적 의도 표현)
--   4) 신규 RPC: get_team_aggregates / get_team_members_usage
--                / assign_app_role / invite_to_team

-- ============================================================
-- 0) 0011 적용 여부 가드
-- ============================================================
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'app_roles'
  ) then
    raise exception '0012 적용 전 0011_hourly_and_teams.sql 를 먼저 적용하세요.';
  end if;
end $$;

-- ============================================================
-- 1) app_roles.role 4단계 확장
-- ============================================================
alter table app_roles drop constraint if exists app_roles_role_check;
alter table app_roles
  add constraint app_roles_role_check
  check (role in ('user', 'team_leader', 'manager', 'admin'));

-- ============================================================
-- 2) RLS 헬퍼 (security definer — 재귀 RLS 회피)
-- ============================================================
-- is_app_admin (0011) 은 "admin 만" 의미로 호환 유지. 별칭 함수로 의도 명확화.
create or replace function is_admin_only()
returns boolean
language sql stable security definer
set search_path = public as $$
  select exists (
    select 1 from app_roles
    where user_id = auth.uid() and role = 'admin'
  );
$$;

create or replace function is_manager_or_above()
returns boolean
language sql stable security definer
set search_path = public as $$
  select exists (
    select 1 from app_roles
    where user_id = auth.uid() and role in ('manager', 'admin')
  );
$$;

create or replace function is_team_leader_or_above()
returns boolean
language sql stable security definer
set search_path = public as $$
  select exists (
    select 1 from app_roles
    where user_id = auth.uid() and role in ('team_leader', 'manager', 'admin')
  );
$$;

-- ============================================================
-- 3) 0011 의 "어드민 전체 조회" 정책 격상 (manager+ 로)
-- ============================================================
-- 의도: manager 도 모든 데이터 열람 가능해야 함.
-- drop + recreate 로 의미 변경을 명시적으로.
--
-- [설계 결정 · 의도적] manager+ 경로는 share_consent 를 요구하지 않는다.
--   team-mate 경로(0011)는 share_consent=true 를 요구하지만, manager+ 는 사내
--   감독 역할이므로 미동의(share_consent=false) 유저의 사용량도 열람 가능.
--   현재 0009 에서 옵트인을 제거해 share_consent 는 사실상 항상 true 라 실효
--   차이는 거의 없음. 이 비대칭은 버그가 아니라 의도된 정책이다 (재플래그 금지).

-- 멱등성: 옛 이름(0011 의 "어드민 전체 조회") + 새 이름 둘 다 drop 후 재생성.
--   → 파일 전체를 몇 번 다시 Run 해도 "policy already exists" 없이 안전.

-- usage_hourly
drop policy if exists "usage_hourly: 어드민 전체 조회" on usage_hourly;
drop policy if exists "usage_hourly: 매니저 이상 전체 조회" on usage_hourly;
create policy "usage_hourly: 매니저 이상 전체 조회"
  on usage_hourly for select
  using (is_manager_or_above());

-- profiles
drop policy if exists "profiles: 어드민 전체 조회" on profiles;
drop policy if exists "profiles: 매니저 이상 전체 조회" on profiles;
create policy "profiles: 매니저 이상 전체 조회"
  on profiles for select
  using (is_manager_or_above());

-- usage_aggregates
drop policy if exists "usage_aggregates: 어드민 전체 조회" on usage_aggregates;
drop policy if exists "usage_aggregates: 매니저 이상 전체 조회" on usage_aggregates;
create policy "usage_aggregates: 매니저 이상 전체 조회"
  on usage_aggregates for select
  using (is_manager_or_above());

-- mcp_usage
drop policy if exists "mcp_usage: 어드민 전체 조회" on mcp_usage;
drop policy if exists "mcp_usage: 매니저 이상 전체 조회" on mcp_usage;
create policy "mcp_usage: 매니저 이상 전체 조회"
  on mcp_usage for select
  using (is_manager_or_above());

-- plugin_usage
drop policy if exists "plugin_usage: 어드민 전체 조회" on plugin_usage;
drop policy if exists "plugin_usage: 매니저 이상 전체 조회" on plugin_usage;
create policy "plugin_usage: 매니저 이상 전체 조회"
  on plugin_usage for select
  using (is_manager_or_above());

-- teams: 어드민 → 매니저 이상
drop policy if exists "teams: 어드민 전체 조회" on teams;
drop policy if exists "teams: 매니저 이상 전체 조회" on teams;
create policy "teams: 매니저 이상 전체 조회"
  on teams for select
  using (is_manager_or_above());

-- team_members: 어드민 → 매니저 이상
drop policy if exists "team_members: 어드민 전체 조회" on team_members;
drop policy if exists "team_members: 매니저 이상 전체 조회" on team_members;
create policy "team_members: 매니저 이상 전체 조회"
  on team_members for select
  using (is_manager_or_above());

-- app_roles: "어드민만 변경" 은 그대로 admin 의미 유지 (시스템 운영)
-- — drop 하지 않음.
-- 단, "어드민 전체 조회" 는 매니저 이상으로 격상
drop policy if exists "app_roles: 어드민 전체 조회" on app_roles;
drop policy if exists "app_roles: 매니저 이상 전체 조회" on app_roles;
create policy "app_roles: 매니저 이상 전체 조회"
  on app_roles for select
  using (is_manager_or_above());

-- ============================================================
-- 4) RPC — get_team_aggregates
-- ============================================================
-- 호출자 권한별 분기:
--   user        → 자기 소속 팀만 (없으면 빈)
--   team_leader → 모든 팀 (합계 + 멤버수)
--   manager+    → 모든 팀 (동일)
--
-- security definer 사용 이유:
--   "팀 총합만, 멤버 단위 숨김" 을 지키려면 team_members / usage_aggregates 의
--   per-row RLS 를 보존(team_leader 가 타팀 멤버 row 를 직접 SELECT 불가)하면서도
--   서버사이드 집계 결과(팀 단위 합계) 는 반환해야 함.
--   → 함수는 definer 로 RLS 우회, 함수 첫 줄에서 권한 가드 + 결과는 집계만.
create or replace function get_team_aggregates(p_range_days int default 30)
returns table (
  team_id      uuid,
  name         text,
  slug         text,
  member_count bigint,
  total_tokens bigint,
  total_cost   numeric
)
language plpgsql security definer stable
set search_path = public as $$
begin
  -- 명시적 권한 가드 (user 는 본인 팀만, 그 외 모두 모든 팀)
  if auth.uid() is null then
    raise exception 'forbidden: 인증된 사용자만 호출 가능';
  end if;

  return query
  with scoped_teams as (
    select t.id, t.name, t.slug
    from teams t
    where
      is_team_leader_or_above()
      or t.id in (
        select tm.team_id from team_members tm where tm.user_id = auth.uid()
      )
  ),
  mem as (
    select tm.team_id, count(*)::bigint as member_count
    from team_members tm
    where tm.team_id in (select id from scoped_teams)
    group by tm.team_id
  ),
  agg as (
    select
      tm.team_id,
      sum(ua.total_tokens)::bigint    as total_tokens,
      sum(ua.total_cost_usd)::numeric as total_cost
    from team_members tm
    join usage_aggregates ua on ua.user_id = tm.user_id
    where tm.team_id in (select id from scoped_teams)
      and ua.date >= current_date - (p_range_days || ' days')::interval
    group by tm.team_id
  )
  select
    st.id   as team_id,
    st.name,
    st.slug,
    coalesce(m.member_count, 0)        as member_count,
    coalesce(a.total_tokens, 0)::bigint as total_tokens,
    coalesce(a.total_cost, 0)::numeric  as total_cost
  from scoped_teams st
  left join mem m on m.team_id = st.id
  left join agg a on a.team_id = st.id
  order by total_cost desc nulls last, st.name;
end;
$$;

-- ============================================================
-- 5) RPC — get_team_members_usage
-- ============================================================
-- 특정 팀의 멤버별 사용량.
-- RLS 가 차단:
--   - user/team_leader 는 자기 팀 멤버만 보임
--   - manager+ 는 모든 팀
-- security invoker — RLS 가 직접 차단.
create or replace function get_team_members_usage(
  p_team_id      uuid,
  p_range_days   int default 30
)
returns table (
  user_id      uuid,
  display_name text,
  avatar_url   text,
  total_tokens bigint,
  total_cost   numeric
)
language sql security invoker stable
set search_path = public as $$
  select
    p.id as user_id,
    coalesce(p.slack_handle, p.name, '알 수 없음') as display_name,
    p.avatar_url,
    coalesce(sum(ua.total_tokens), 0)::bigint  as total_tokens,
    coalesce(sum(ua.total_cost_usd), 0)::numeric as total_cost
  from team_members tm
  join profiles p on p.id = tm.user_id
  left join usage_aggregates ua
    on ua.user_id = tm.user_id
    and ua.date >= current_date - (p_range_days || ' days')::interval
  where tm.team_id = p_team_id
  group by p.id, p.slack_handle, p.name, p.avatar_url
  order by total_cost desc nulls last;
$$;

-- ============================================================
-- 6) RPC — assign_app_role
-- ============================================================
-- manager+ 만 호출 가능. user/team_leader 가 호출하면 예외.
-- security definer — app_roles INSERT/UPDATE 정책은 admin 만 허용이지만
-- manager 도 역할 부여가 가능해야 하므로 우회. 내부에서 권한 검사 필수.
create or replace function assign_app_role(
  p_user_id uuid,
  p_role    text
)
returns void
language plpgsql security definer
set search_path = public as $$
begin
  if not is_manager_or_above() then
    raise exception 'forbidden: manager 이상만 역할 부여 가능';
  end if;
  if p_role not in ('user', 'team_leader', 'manager', 'admin') then
    raise exception 'invalid role: %', p_role;
  end if;
  -- 권한 상승 방지: admin 부여 또는 기존 admin 의 변경/회수는 admin 만 가능.
  -- (manager 가 자신/타인을 admin 으로 승격하거나 기존 admin 을 강등하지 못하게)
  if (p_role = 'admin'
      or exists (select 1 from app_roles where user_id = p_user_id and role = 'admin'))
     and not is_admin_only() then
    raise exception 'forbidden: admin 역할 부여/변경은 admin 만 가능';
  end if;
  insert into app_roles (user_id, role)
  values (p_user_id, p_role)
  on conflict (user_id) do update set role = excluded.role;
end;
$$;

-- ============================================================
-- 7) RPC — invite_to_team
-- ============================================================
-- 팀 owner/admin (team_members.role) 만 호출 가능.
-- p_identifier 는 slack_handle 또는 email. 매칭되는 profile 1 개를 찾아
-- team_members 에 'member' 로 추가. 이미 있으면 no-op.
create or replace function invite_to_team(
  p_team_id    uuid,
  p_identifier text
)
returns uuid
language plpgsql security definer
set search_path = public as $$
declare
  v_user_id uuid;
begin
  if not is_team_admin(p_team_id) then
    raise exception 'forbidden: 팀 owner/admin 만 초대 가능';
  end if;

  select id into v_user_id
  from profiles
  where slack_handle = p_identifier or email = p_identifier
  limit 1;

  if v_user_id is null then
    raise exception 'profile 없음: % (해당 사용자가 먼저 로그인해야 합니다)', p_identifier;
  end if;

  insert into team_members (team_id, user_id, role)
  values (p_team_id, v_user_id, 'member')
  on conflict (team_id, user_id) do nothing;

  return v_user_id;
end;
$$;

-- ============================================================
-- 8) 호환 — 기존 is_app_admin alias 유지
-- ============================================================
-- 의미: "admin 만". 0011 에서 정의된 것과 동일하나 명시적으로 갱신.
create or replace function is_app_admin()
returns boolean
language sql stable security definer
set search_path = public as $$
  select is_admin_only();
$$;
