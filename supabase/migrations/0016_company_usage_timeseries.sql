-- 0016_company_usage_timeseries.sql: 사용량 분석 — 사원별 토큰 시계열 (평균/최대/최소 라인차트용)
--
-- 선행: 0011(usage_hourly), 0012(is_manager_or_above)
--
-- 목적: 사용량 분석 페이지의 "사원 평균/최대/최소 토큰" 라인차트.
--   per-bucket 으로 (사원별 합계)의 평균/최대/최소를 그리려면 사원×버킷 단위 데이터가 필요.
--   클라이언트에서 일/주/월 버킷팅 + 통계를 계산하므로, 서버는 (user, date|hour, tokens) 만 반환.
--   manager+ 가드, security definer.

-- 일별 (일/주/월 토글 공용 — 클라이언트가 주/월로 재버킷)
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
  where ua.date >= current_date - (p_range_days || ' days')::interval
  group by ua.user_id, ua.date;
end;
$$;

-- 시간별 (UTC hour 버킷 — 클라이언트가 로컬 시각으로 변환)
create or replace function get_company_hourly_by_user(p_hours int default 48)
returns table (
  user_id      uuid,
  hour_utc     timestamptz,
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
    uh.user_id,
    uh.hour_utc,
    sum(uh.input_tokens + uh.output_tokens + uh.cache_read + uh.cache_write)::bigint as total_tokens
  from usage_hourly uh
  where uh.hour_utc >= now() - (p_hours || ' hours')::interval
  group by uh.user_id, uh.hour_utc;
end;
$$;
