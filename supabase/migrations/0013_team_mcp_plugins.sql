-- 0013_team_mcp_plugins.sql: 팀별 MCP / 플러그인 TOP RPC
--
-- 선행: 0011_hourly_and_teams.sql, 0012_role_hierarchy.sql
--
-- 목적: 팀 대시보드(팀 관리 > 팀 클릭 드릴다운)에서 팀 멤버 합산 MCP/플러그인 TOP 표시.
--       리더보드(멤버별)는 기존 get_team_members_usage 로 충분하므로 추가하지 않는다.
--
-- security invoker — get_team_members_usage 와 동일 정책.
--   mcp_usage / plugin_usage 의 RLS 가 호출자 가시 범위를 강제:
--     팀메이트(share_consent=true) 또는 manager+ 만 멤버 row 가 보인다.
--   → "내 팀 목록"에서 진입하는 본인 소속 팀은 team_leader 도 팀메이트 경로로 열람 가능.

-- ============================================================
-- 1) get_team_mcp — 팀 멤버 합산 MCP TOP
-- ============================================================
create or replace function get_team_mcp(
  p_team_id    uuid,
  p_range_days int default 30
)
returns table (
  mcp_server text,
  count      bigint
)
language sql security invoker stable
set search_path = public as $$
  select
    mu.mcp_server,
    sum(mu.count)::bigint as count
  from team_members tm
  join mcp_usage mu on mu.user_id = tm.user_id
  where tm.team_id = p_team_id
    and mu.date >= current_date - (p_range_days || ' days')::interval
  group by mu.mcp_server
  order by count desc
  limit 20;
$$;

-- ============================================================
-- 2) get_team_plugins — 팀 멤버 합산 플러그인 TOP
-- ============================================================
create or replace function get_team_plugins(
  p_team_id    uuid,
  p_range_days int default 30
)
returns table (
  plugin_id text,
  count     bigint
)
language sql security invoker stable
set search_path = public as $$
  select
    pu.plugin_id,
    sum(pu.count)::bigint as count
  from team_members tm
  join plugin_usage pu on pu.user_id = tm.user_id
  where tm.team_id = p_team_id
    and pu.date >= current_date - (p_range_days || ' days')::interval
  group by pu.plugin_id
  order by count desc
  limit 20;
$$;
