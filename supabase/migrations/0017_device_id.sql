-- 0017_device_id.sql: 다기기 집계 분리 — device_id PK 도입
--
-- 선행: 0001(usage_aggregates/mcp_usage/plugin_usage), 0011(usage_hourly),
--       0014(tool_usage)
--
-- 배경:
--   기존 PK 는 (user_id, date, source) 등 기기 구분이 없어, 한 유저가 여러 기기에서
--   동기화하면 마지막 upsert 가 이전 기기 합계를 덮어써 토큰이 누락됐다.
--   각 행에 device_id 를 추가하고 PK 에 포함해 기기별 행을 분리 보존한다.
--   읽기(대시보드/RPC)는 기존대로 user 단위 SUM 이라 자동 합산 — 변경 불필요.
--
-- 데이터 삭제 금지:
--   기존 행은 device_id='legacy' 로 백필된다. 신규 sync 가 실제 device_id 로 새 행을
--   올린 뒤, 클라이언트가 1회 purge_my_legacy() 를 호출해 본인 legacy 행만 정리한다.
--
-- 멱등성: add column if not exists / drop constraint if exists 로 재실행 안전.

-- ============================================================
-- 1) usage_aggregates  →  PK (user_id, date, source, device_id)
-- ============================================================
alter table usage_aggregates add column if not exists device_id text not null default 'legacy';
alter table usage_aggregates drop constraint if exists usage_aggregates_pkey;
alter table usage_aggregates add primary key (user_id, date, source, device_id);

-- ============================================================
-- 2) usage_hourly  →  PK (user_id, hour_utc, source, model, device_id)
-- ============================================================
alter table usage_hourly add column if not exists device_id text not null default 'legacy';
alter table usage_hourly drop constraint if exists usage_hourly_pkey;
alter table usage_hourly add primary key (user_id, hour_utc, source, model, device_id);

-- ============================================================
-- 3) mcp_usage  →  PK (user_id, date, mcp_server, device_id)
-- ============================================================
alter table mcp_usage add column if not exists device_id text not null default 'legacy';
alter table mcp_usage drop constraint if exists mcp_usage_pkey;
alter table mcp_usage add primary key (user_id, date, mcp_server, device_id);

-- ============================================================
-- 4) plugin_usage  →  PK (user_id, date, plugin_id, device_id)
-- ============================================================
alter table plugin_usage add column if not exists device_id text not null default 'legacy';
alter table plugin_usage drop constraint if exists plugin_usage_pkey;
alter table plugin_usage add primary key (user_id, date, plugin_id, device_id);

-- ============================================================
-- 5) tool_usage  →  PK (user_id, date, tool_name, device_id)
-- ============================================================
alter table tool_usage add column if not exists device_id text not null default 'legacy';
alter table tool_usage drop constraint if exists tool_usage_pkey;
alter table tool_usage add primary key (user_id, date, tool_name, device_id);

-- ============================================================
-- 6) purge_my_legacy() — 본인 legacy 행 1회 정리
-- ============================================================
-- 신규 device_id 행 업로드가 성공한 뒤 클라이언트가 1회 호출.
-- security definer 지만 모든 delete 가 auth.uid() 로 제한되어 본인 행만 삭제한다
-- (0011/0012 의 security definer 스타일 + auth.uid() 가드 동일).
create or replace function purge_my_legacy()
returns void
language plpgsql security definer
set search_path = public as $$
begin
  delete from usage_aggregates where user_id = auth.uid() and device_id = 'legacy';
  delete from usage_hourly     where user_id = auth.uid() and device_id = 'legacy';
  delete from mcp_usage        where user_id = auth.uid() and device_id = 'legacy';
  delete from plugin_usage     where user_id = auth.uid() and device_id = 'legacy';
  delete from tool_usage       where user_id = auth.uid() and device_id = 'legacy';
end;
$$;

grant execute on function purge_my_legacy() to authenticated;
