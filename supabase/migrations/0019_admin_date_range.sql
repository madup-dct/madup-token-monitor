-- 0019_admin_date_range.sql: AdminAnalytics 임의 날짜 범위 조회 지원
--
-- 선행: 0015(get_directory, get_mcp_users, get_plugin_users),
--        0009(get_top_mcp_servers, get_top_plugins 최종 정의)
--
-- 변경 내용:
--   5개 RPC 에 p_start_date date / p_end_date date 파라미터 추가.
--   - 둘 다 NOT NULL → date BETWEEN p_start_date AND p_end_date
--   - 그 외(하나라도 null) → 기존 range_days 필터 그대로
--   기존 본문 로직·집계·정렬·security definer·RLS 가드 완전 보존.
--   하위 호환: 기존 호출부(range_days 만 전달)는 신규 파라미터가 null default 라 동작 무변.
--
-- PostgREST 오버로드 모호성 방지:
--   기존 시그니처를 drop 후 단일 함수로 재정의.

-- ============================================================
-- 1) get_directory
-- ============================================================
drop function if exists get_directory(int);

create or replace function get_directory(
  p_range_days  int  default 30,
  p_start_date  date default null,
  p_end_date    date default null
)
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
           sum(ua.total_tokens)::bigint    as total_tokens,
           sum(ua.total_cost_usd)::numeric as total_cost
    from usage_aggregates ua
    where
      case
        when p_start_date is not null and p_end_date is not null
          then ua.date between p_start_date and p_end_date
        else ua.date >= current_date - (p_range_days || ' days')::interval
      end
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

grant execute on function get_directory(int, date, date)
  to public, anon, authenticated, postgres, service_role;

-- ============================================================
-- 2) get_top_mcp_servers
-- ============================================================
drop function if exists get_top_mcp_servers(int);

create or replace function get_top_mcp_servers(
  range_days   int  default 30,
  p_start_date date default null,
  p_end_date   date default null
)
returns table (
  mcp_server  text,
  total_count bigint
)
language sql security definer stable as $$
  select
    mu.mcp_server,
    sum(mu.count) as total_count
  from mcp_usage mu
  join profiles p on p.id = mu.user_id
  where
    case
      when p_start_date is not null and p_end_date is not null
        then mu.date between p_start_date and p_end_date
      else mu.date >= current_date - (range_days || ' days')::interval
    end
  group by mu.mcp_server
  order by total_count desc
  limit 10;
$$;

grant execute on function get_top_mcp_servers(int, date, date)
  to public, anon, authenticated, postgres, service_role;

-- ============================================================
-- 3) get_top_plugins
-- ============================================================
drop function if exists get_top_plugins(int);

create or replace function get_top_plugins(
  range_days   int  default 30,
  p_start_date date default null,
  p_end_date   date default null
)
returns table (
  plugin_id   text,
  total_count bigint
)
language sql security definer stable as $$
  select
    pu.plugin_id,
    sum(pu.count) as total_count
  from plugin_usage pu
  join profiles p on p.id = pu.user_id
  where
    case
      when p_start_date is not null and p_end_date is not null
        then pu.date between p_start_date and p_end_date
      else pu.date >= current_date - (range_days || ' days')::interval
    end
  group by pu.plugin_id
  order by total_count desc
  limit 10;
$$;

grant execute on function get_top_plugins(int, date, date)
  to public, anon, authenticated, postgres, service_role;

-- ============================================================
-- 4) get_mcp_users
-- ============================================================
drop function if exists get_mcp_users(text, int);

create or replace function get_mcp_users(
  p_mcp_server text,
  p_range_days int  default 30,
  p_start_date date default null,
  p_end_date   date default null
)
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
    and (
      case
        when p_start_date is not null and p_end_date is not null
          then mu.date between p_start_date and p_end_date
        else mu.date >= current_date - (p_range_days || ' days')::interval
      end
    )
  group by p.id, p.name, p.slack_handle, p.avatar_url
  order by total_count desc
  limit 50;
end;
$$;

grant execute on function get_mcp_users(text, int, date, date)
  to public, anon, authenticated, postgres, service_role;

-- ============================================================
-- 5) get_plugin_users
-- ============================================================
drop function if exists get_plugin_users(text, int);

create or replace function get_plugin_users(
  p_plugin_id  text,
  p_range_days int  default 30,
  p_start_date date default null,
  p_end_date   date default null
)
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
    and (
      case
        when p_start_date is not null and p_end_date is not null
          then pu.date between p_start_date and p_end_date
        else pu.date >= current_date - (p_range_days || ' days')::interval
      end
    )
  group by p.id, p.name, p.slack_handle, p.avatar_url
  order by total_count desc
  limit 50;
end;
$$;

grant execute on function get_plugin_users(text, int, date, date)
  to public, anon, authenticated, postgres, service_role;
