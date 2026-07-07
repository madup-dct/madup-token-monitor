-- 0021_kst_date_boundary.sql: 집계 RPC 날짜 경계를 UTC current_date → KST 로 교정
--
-- 문제: usage_aggregates.date 등 날짜 버킷은 클라이언트(aggregator.rs)가
--   chrono::Local(KST) 로 만드는데, RPC 필터는 Postgres current_date(세션 tz=UTC)
--   기준이었다. KST 00~09시 사이엔 current_date 가 KST 어제라서
--   "오늘"(days=0) 조회에 전일 데이터가 통째로 합산 표시됨 (2026-07-03 발견).
--
-- 수정: kst_today() 헬퍼 추가, current_date 를 쓰던 16개 RPC 를 최신 정의
--   그대로 재생성하며 경계만 kst_today() 로 교체. 본문 로직·권한·grant 불변.
--   (create or replace 는 기존 ACL 을 보존한다.)
--
-- 재생성 대상 (최신 정의 출처):
--   0009: get_weekly_top10
--   0010: get_top_users, get_user_mcp, get_user_plugins
--   0012: get_team_aggregates, get_team_members_usage
--   0013: get_team_mcp, get_team_plugins
--   0014: get_user_tools
--   0016: get_company_usage_by_user
--   0019: get_directory, get_top_mcp_servers, get_top_plugins,
--         get_mcp_users, get_plugin_users
--   0020: get_team_top_models (hour_utc 는 timestamptz → KST 자정을 변환해 비교)
--
-- ⚠️ 이후 새 RPC 에서 날짜 경계가 필요하면 current_date 금지, kst_today() 사용.

-- ============================================================
-- 0) kst_today — KST 달력 기준 오늘
-- ============================================================
create or replace function kst_today()
returns date
language sql stable as $$
  select (now() at time zone 'Asia/Seoul')::date
$$;

grant execute on function kst_today() to public;

-- ============================================================
-- 1) get_weekly_top10 (0009)
-- ============================================================
create or replace function get_weekly_top10()
returns table (
  display_name text,
  avatar_url   text,
  total_cost   numeric
)
language sql security definer stable as $$
  select
    coalesce(p.slack_handle, p.name, '알 수 없음') as display_name,
    p.avatar_url,
    sum(ua.total_cost_usd) as total_cost
  from usage_aggregates ua
  join profiles p on p.id = ua.user_id
  where ua.date >= kst_today() - interval '7 days'
  group by p.id, p.slack_handle, p.name, p.avatar_url
  order by total_cost desc
  limit 10;
$$;

-- ============================================================
-- 2) get_top_users (0010)
-- ============================================================
create or replace function get_top_users(range_days int default 30, max_rows int default 50)
returns table (
  user_id      uuid,
  display_name text,
  avatar_url   text,
  total_cost   numeric,
  total_tokens bigint
)
language sql security definer stable as $$
  select
    p.id as user_id,
    coalesce(p.slack_handle, p.name, '알 수 없음') as display_name,
    p.avatar_url,
    sum(ua.total_cost_usd) as total_cost,
    sum(ua.total_tokens) as total_tokens
  from usage_aggregates ua
  join profiles p on p.id = ua.user_id
  where ua.date >= kst_today() - (range_days || ' days')::interval
  group by p.id, p.slack_handle, p.name, p.avatar_url
  order by total_cost desc
  limit max_rows;
$$;

-- ============================================================
-- 3) get_user_mcp (0010)
-- ============================================================
create or replace function get_user_mcp(p_user uuid, range_days int default 30)
returns table (
  mcp_server  text,
  total_count bigint
)
language sql security definer stable as $$
  select
    mu.mcp_server,
    sum(mu.count) as total_count
  from mcp_usage mu
  where mu.user_id = p_user
    and mu.date >= kst_today() - (range_days || ' days')::interval
  group by mu.mcp_server
  order by total_count desc
  limit 10;
$$;

-- ============================================================
-- 4) get_user_plugins (0010)
-- ============================================================
create or replace function get_user_plugins(p_user uuid, range_days int default 30)
returns table (
  plugin_id   text,
  total_count bigint
)
language sql security definer stable as $$
  select
    pu.plugin_id,
    sum(pu.count) as total_count
  from plugin_usage pu
  where pu.user_id = p_user
    and pu.date >= kst_today() - (range_days || ' days')::interval
  group by pu.plugin_id
  order by total_count desc
  limit 10;
$$;

-- ============================================================
-- 5) get_team_aggregates (0012)
-- ============================================================
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
      and ua.date >= kst_today() - (p_range_days || ' days')::interval
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
-- 6) get_team_members_usage (0012)
-- ============================================================
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
    and ua.date >= kst_today() - (p_range_days || ' days')::interval
  where tm.team_id = p_team_id
  group by p.id, p.slack_handle, p.name, p.avatar_url
  order by total_cost desc nulls last;
$$;

-- ============================================================
-- 7) get_team_mcp (0013)
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
    and mu.date >= kst_today() - (p_range_days || ' days')::interval
  group by mu.mcp_server
  order by count desc
  limit 20;
$$;

-- ============================================================
-- 8) get_team_plugins (0013)
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
    and pu.date >= kst_today() - (p_range_days || ' days')::interval
  group by pu.plugin_id
  order by count desc
  limit 20;
$$;

-- ============================================================
-- 9) get_user_tools (0014)
-- ============================================================
create or replace function get_user_tools(p_user uuid, range_days int default 30)
returns table (
  tool_name   text,
  total_count bigint
)
language sql security definer stable
set search_path = public as $$
  select
    tu.tool_name,
    sum(tu.count) as total_count
  from tool_usage tu
  where tu.user_id = p_user
    and tu.date >= kst_today() - (range_days || ' days')::interval
  group by tu.tool_name
  order by total_count desc
  limit 10;
$$;

-- ============================================================
-- 10) get_company_usage_by_user (0016)
-- ============================================================
create or replace function get_company_usage_by_user(p_range_days int default 365)
returns table (
  user_id      uuid,
  date         date,
  total_tokens bigint
)
language plpgsql security definer stable
set search_path = public as $$
begin
  if not is_manager_or_above() then
    raise exception 'forbidden: manager 이상만 조회 가능';
  end if;
  return query
  select
    ua.user_id,
    ua.date,
    sum(ua.total_tokens)::bigint as total_tokens
  from usage_aggregates ua
  where ua.date >= kst_today() - (p_range_days || ' days')::interval
  group by ua.user_id, ua.date;
end;
$$;

-- ============================================================
-- 11) get_directory (0019)
-- ============================================================
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
        else ua.date >= kst_today() - (p_range_days || ' days')::interval
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

-- ============================================================
-- 12) get_top_mcp_servers (0019)
-- ============================================================
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
      else mu.date >= kst_today() - (range_days || ' days')::interval
    end
  group by mu.mcp_server
  order by total_count desc
  limit 10;
$$;

-- ============================================================
-- 13) get_top_plugins (0019)
-- ============================================================
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
      else pu.date >= kst_today() - (range_days || ' days')::interval
    end
  group by pu.plugin_id
  order by total_count desc
  limit 10;
$$;

-- ============================================================
-- 14) get_mcp_users (0019)
-- ============================================================
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
        else mu.date >= kst_today() - (p_range_days || ' days')::interval
      end
    )
  group by p.id, p.name, p.slack_handle, p.avatar_url
  order by total_count desc
  limit 50;
end;
$$;

-- ============================================================
-- 15) get_plugin_users (0019)
-- ============================================================
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
        else pu.date >= kst_today() - (p_range_days || ' days')::interval
      end
    )
  group by p.id, p.name, p.slack_handle, p.avatar_url
  order by total_count desc
  limit 50;
end;
$$;

-- ============================================================
-- 16) get_team_top_models (0020)
-- ============================================================
create or replace function get_team_top_models(
  p_team_id uuid,
  p_days    int default 30,
  p_limit   int default 5
)
returns table (
  model        text,
  total_tokens bigint,
  total_cost   numeric
)
language sql security invoker stable
set search_path = public as $$
  select
    uh.model,
    sum(uh.input_tokens + uh.output_tokens + uh.cache_read + uh.cache_write)::bigint as total_tokens,
    sum(uh.cost_usd) as total_cost
  from team_members tm
  join usage_hourly uh on uh.user_id = tm.user_id
  where tm.team_id = p_team_id
    -- 모델없음(빈문자열) row 는 제외 — 모델 차원이 없는 source 의 집계.
    and uh.model <> ''
    -- 형제 RPC 와 동일한 KST 달력 경계. hour_utc 는 timestamptz 이므로
    -- KST 자정을 timestamptz 로 변환해 비교 (KST=UTC+9, 정시 버킷과 정렬됨).
    and uh.hour_utc >= timezone('Asia/Seoul', (kst_today() - (p_days || ' days')::interval))
  group by uh.model
  order by total_tokens desc
  limit p_limit;
$$;
