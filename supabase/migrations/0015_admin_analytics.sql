-- 0015_admin_analytics.sql: 매니저 전용 "경영 분석" 페이지 RPC
--
-- 선행: 0010(get_user_*), 0011(are_team_mates), 0012(is_manager_or_above)
--
-- 목적:
--   1) get_directory        — 전사 유저 테이블 (권한·팀·토큰·이름·이메일)
--   2) get_mcp_users        — 특정 MCP 를 쓴 사용자 + 호출수
--   3) get_plugin_users     — 특정 플러그인을 쓴 사용자 + 사용수
--
-- 모두 security definer + 첫 줄에서 manager 이상 가드 (전사 데이터 노출이므로).
-- 멱등: create or replace.

-- ============================================================
-- 1) get_directory — 전사 유저 디렉토리 (권한/팀/토큰/비용)
-- ============================================================
create or replace function get_directory(p_range_days int default 30)
returns table (
  user_id      uuid,
  display_name text,
  email        text,
  role         text,
  teams        text,
  total_tokens bigint,
  total_cost   numeric
)
language plpgsql security definer stable
set search_path = public as $$
begin
  if not is_manager_or_above() then
    raise exception 'forbidden: manager 이상만 조회 가능';
  end if;

  return query
  with usage as (
    select ua.user_id,
           sum(ua.total_tokens)::bigint   as total_tokens,
           sum(ua.total_cost_usd)::numeric as total_cost
    from usage_aggregates ua
    where ua.date >= current_date - (p_range_days || ' days')::interval
    group by ua.user_id
  ),
  tm as (
    select t2.user_id, string_agg(distinct tt.name, ', ') as teams
    from team_members t2
    join teams tt on tt.id = t2.team_id
    group by t2.user_id
  )
  select
    p.id as user_id,
    coalesce(p.name, p.slack_handle, '알 수 없음') as display_name,
    p.email,
    coalesce(ar.role, 'user') as role,
    tm.teams,
    coalesce(u.total_tokens, 0)::bigint as total_tokens,
    coalesce(u.total_cost, 0)::numeric  as total_cost
  from profiles p
  left join app_roles ar on ar.user_id = p.id
  left join usage u on u.user_id = p.id
  left join tm on tm.user_id = p.id
  order by total_tokens desc nulls last, display_name;
end;
$$;

-- ============================================================
-- 2) get_mcp_users — 특정 MCP 를 쓴 사용자
-- ============================================================
create or replace function get_mcp_users(p_mcp_server text, p_range_days int default 30)
returns table (
  user_id      uuid,
  display_name text,
  avatar_url   text,
  total_count  bigint
)
language plpgsql security definer stable
set search_path = public as $$
begin
  if not is_manager_or_above() then
    raise exception 'forbidden: manager 이상만 조회 가능';
  end if;
  return query
  select
    p.id as user_id,
    coalesce(p.name, p.slack_handle, '알 수 없음') as display_name,
    p.avatar_url,
    sum(mu.count)::bigint as total_count
  from mcp_usage mu
  join profiles p on p.id = mu.user_id
  where mu.mcp_server = p_mcp_server
    and mu.date >= current_date - (p_range_days || ' days')::interval
  group by p.id, p.name, p.slack_handle, p.avatar_url
  order by total_count desc
  limit 50;
end;
$$;

-- ============================================================
-- 3) get_plugin_users — 특정 플러그인을 쓴 사용자
-- ============================================================
create or replace function get_plugin_users(p_plugin_id text, p_range_days int default 30)
returns table (
  user_id      uuid,
  display_name text,
  avatar_url   text,
  total_count  bigint
)
language plpgsql security definer stable
set search_path = public as $$
begin
  if not is_manager_or_above() then
    raise exception 'forbidden: manager 이상만 조회 가능';
  end if;
  return query
  select
    p.id as user_id,
    coalesce(p.name, p.slack_handle, '알 수 없음') as display_name,
    p.avatar_url,
    sum(pu.count)::bigint as total_count
  from plugin_usage pu
  join profiles p on p.id = pu.user_id
  where pu.plugin_id = p_plugin_id
    and pu.date >= current_date - (p_range_days || ' days')::interval
  group by p.id, p.name, p.slack_handle, p.avatar_url
  order by total_count desc
  limit 50;
end;
$$;

