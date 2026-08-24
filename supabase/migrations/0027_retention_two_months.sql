-- 0027_retention_two_months.sql: 사용량 데이터 보존기간 2개월 정책
--
-- 정책: "이번 달 + 직전 2개 달력 월" 만 보관. 컷오프 = (이번 달 1일) − 2개월.
--   예) 2026-08-24 → 2026-06-01 미만 삭제 (6/7/8월 보존).
--
-- 로컬 SQLite(src-tauri/src/retention.rs) 와 같은 정의를 쓴다. 날짜 경계는 반드시
-- kst_today()(0021) 기준 — current_date(UTC) 를 쓰면 KST 00~09시에 하루 밀린다.
--
-- 삭제 대상은 사용량 버킷 5개 테이블뿐이다:
--   usage_aggregates / usage_hourly / mcp_usage / plugin_usage / tool_usage
-- 제외:
--   messages                — 팀 채팅, 사용량 데이터가 아님
--   claude/codex_limit_snapshots — 계정당 1 row upsert (히스토리가 아니라 최신 상태)
--   profiles / teams / *_owner   — 마스터 데이터
--
-- ⚠️ 되돌릴 수 없다. 컷오프 이전 전사 집계(리더보드 히스토리, 사용자 상세 365일 조회)는
--    영구 삭제된다. 로컬 앱은 최대 2~3개월치만 갖고 있어 재업로드로 복구되지 않는다.

-- ============================================================
-- 1) 보존 컷오프 — 이 날짜 미만이 삭제 대상
-- ============================================================
create or replace function retention_cutoff_date()
returns date
language sql stable as $$
  select (date_trunc('month', kst_today()::timestamp) - interval '2 months')::date
$$;

grant execute on function retention_cutoff_date() to public;

-- ============================================================
-- 2) 정리 함수 — 테이블별 삭제 행 수를 돌려준다
-- ============================================================
-- security definer: RLS(본인 row 만) 를 우회해 전 유저 데이터를 일괄 정리해야 한다.
-- 전 유저 데이터를 지우므로 앱 클라이언트(authenticated/anon)에는 실행 권한을 주지 않는다
-- — pg_cron(postgres) 과 DB 관리자만 호출한다.
create or replace function purge_old_usage()
returns table (purged_table text, deleted_rows bigint)
language plpgsql security definer
set search_path = public
as $$
declare
  cutoff       date        := retention_cutoff_date();
  -- usage_hourly.hour_utc 는 timestamptz — KST 자정을 UTC 시각으로 변환해 비교한다.
  cutoff_utc   timestamptz := timezone('Asia/Seoul', cutoff::timestamp);
  n            bigint;
begin
  delete from usage_aggregates where date < cutoff;
  get diagnostics n = row_count;
  purged_table := 'usage_aggregates'; deleted_rows := n; return next;

  delete from usage_hourly where hour_utc < cutoff_utc;
  get diagnostics n = row_count;
  purged_table := 'usage_hourly'; deleted_rows := n; return next;

  delete from mcp_usage where date < cutoff;
  get diagnostics n = row_count;
  purged_table := 'mcp_usage'; deleted_rows := n; return next;

  delete from plugin_usage where date < cutoff;
  get diagnostics n = row_count;
  purged_table := 'plugin_usage'; deleted_rows := n; return next;

  delete from tool_usage where date < cutoff;
  get diagnostics n = row_count;
  purged_table := 'tool_usage'; deleted_rows := n; return next;
end;
$$;

-- 함수 EXECUTE 는 기본이 PUBLIC 이므로 명시적으로 회수한다.
revoke execute on function purge_old_usage() from public;

-- ============================================================
-- 3) 삭제 대상 미리보기 — 실행 전 규모 확인용 (읽기 전용)
-- ============================================================
create or replace function retention_purge_preview()
returns table (purged_table text, pending_rows bigint)
language sql security definer
set search_path = public
stable as $$
  with cutoff as (
    select retention_cutoff_date() as d,
           timezone('Asia/Seoul', retention_cutoff_date()::timestamp) as d_utc
  )
  select 'usage_aggregates', count(*) from usage_aggregates, cutoff where date < cutoff.d
  union all
  select 'usage_hourly',     count(*) from usage_hourly, cutoff where hour_utc < cutoff.d_utc
  union all
  select 'mcp_usage',        count(*) from mcp_usage, cutoff where date < cutoff.d
  union all
  select 'plugin_usage',     count(*) from plugin_usage, cutoff where date < cutoff.d
  union all
  select 'tool_usage',       count(*) from tool_usage, cutoff where date < cutoff.d
$$;

revoke execute on function retention_purge_preview() from public;

-- ============================================================
-- 4) 일 1회 스케줄 (pg_cron)
-- ============================================================
-- pg_cron 은 UTC 기준. 15:10 UTC = 00:10 KST (KST 달력 날짜가 바뀐 직후).
-- 확장이 없으면 스케줄만 생략하고 마이그레이션은 성공시킨다 — 함수는 그대로 남으므로
-- 확장 활성화 후 이 블록만 다시 실행하면 된다.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('purge-old-usage', '10 15 * * *', 'select purge_old_usage()');
    raise notice 'pg_cron 스케줄 등록: purge-old-usage (매일 15:10 UTC = 00:10 KST)';
  else
    raise notice 'pg_cron 미설치 — purge_old_usage() 자동 스케줄을 건너뛴다. 확장 활성화 후 이 do 블록 재실행 필요.';
  end if;
end $$;
