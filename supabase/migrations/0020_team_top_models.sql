-- 0020_team_top_models.sql: 팀 멤버 합산 사용 모델별 토큰 TOP RPC
--
-- 선행: 0017_device_id.sql
--
-- 목적: 내 팀 대시보드에서 팀 멤버 합산 "사용 모델 TOP5" (토큰 기준) 표시.
--       모델 차원은 usage_hourly 에만 존재 (최근 30일 적재).
--
-- security invoker — get_team_mcp(0013)와 동일 정책.
--   usage_hourly 의 RLS 가 호출자 가시 범위를 강제:
--     본인 / 팀메이트(share_consent=true) / manager+ 만 row 가 보인다.

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
    -- 형제 RPC(get_team_members_usage 0012, get_team_mcp 0013)와 동일한
    -- current_date 경계 — 같은 캐러셀 face 에 나란히 표시되는 카드들이
    -- 같은 기간을 집계해야 한다 (KST 00~09시 동안 하루 어긋나는 모순 방지).
    and uh.hour_utc >= current_date - (p_days || ' days')::interval
  group by uh.model
  order by total_tokens desc
  limit p_limit;
$$;

grant execute on function get_team_top_models(uuid, int, int) to authenticated;
