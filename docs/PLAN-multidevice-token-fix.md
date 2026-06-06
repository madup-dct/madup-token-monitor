# 플랜 — 다기기 토큰 사용량 합산 fix (device_id 도입)

> 작성: 2026-06-05
> 상태: **플랜 작성 완료 — 구현/승인 대기.** 코드 미변경.
> 발단: 박승근(skpark) "여러 기기 Claude Code 토큰이 합산 안 됨" 이슈 (2026-06-05).
> 관련 조사 근거: 본 세션 워크플로 3건 (DB 실데이터 / aggregator 분석 / reader 감사).
> 다른 세션이 이 문서만 보고도 그대로 이어받을 수 있도록 작성됨.

---

## 0. 배경 — 확정된 근본 원인

다기기 사용 시 토큰이 **합산이 아니라 마지막 sync 기기 값으로 덮어써진다.**

근거 (코드 + DB):

1. **스키마에 기기 차원 없음.** 5개 집계 테이블 PK 가 `user_id + 시간 + 분류` 뿐 (예: `usage_aggregates` = `(user_id, date, source)`, `0001_init.sql:45`). hostname/device_id 컬럼이 Supabase·로컬 SQLite 어디에도 없음.
2. **업로드가 치환(UPSERT replace).** `aggregator.rs:315` `Prefer: resolution=merge-duplicates` → PostgREST 가 `ON CONFLICT DO UPDATE SET = EXCLUDED` 로 변환. PostgREST 에 "가산" resolution 자체가 없음.
3. **각 기기는 자기 로컬 전체 합만 올림.** `read_usage_aggregates`(`aggregator.rs:83-138`)는 그 기기 `usage_events` 전체를 `(date,source)` 합산. → 기기 A(100M) 후 기기 B(30M) 업로드 시 같은 PK 충돌 → **130M 이어야 할 게 30M 으로 손실.**
4. **DB 증거.** skpark 6/4 `usage_hourly` raw(input+output)=1,079,317 인데 `usage_aggregates` total=652,162 로 역전 (aggregates 가 cache 토큰 포함인데도 작음 → 6/4 행이 더 가벼운 기기 값으로 덮인 정황).

영향: 5개 테이블 전부(`usage_aggregates`/`usage_hourly`/`mcp_usage`/`plugin_usage`/`tool_usage`). 본인 Dashboard(`useUsage.ts:113` 1차 aggregates, 실패 시 로컬 단일기기) + 관리자 UserDashboard(`teams.ts:174` 100% aggregates, 방어막 없음) 모두 under-count.

---

## 1. 해결 전략 — `device_id` 차원 추가 (안 1)

각 기기가 **자기 device_id 로 분리된 행**을 쓰게 하고, 조회는 `user_id` 기준 SUM 으로 합산. PK 에 device_id 가 들어가므로 기기끼리 더는 서로 덮어쓰지 않는다.

대안(서버측 가산 upsert)은 업로드를 "전체기간 재업로드 → 델타"로 전면 개편해야 해 위험·범위가 커서 폐기. (조사 노트 참조)

**핵심 이점 — 변경 범위가 작다.** reader 감사 결과 RPC 16개·프론트 SELECT 3곳 모두 이미 `user_id`/date/hour 기준으로 SUM 하므로 device 행이 늘어도 자동 합산된다 (§3). 실제 변경은 "쓰기 경로"에 집중된다.

---

## 2. 변경 범위 요약

| 영역 | 변경 | 비고 |
|---|---|---|
| 로컬 device_id 생성·영속 | **신규** | `dirs::config_dir()/madup-token-monitor/device.json` 에 uuidv4 get-or-create |
| `Cargo.toml` | `uuid` 의존 추가 | 현재 직접 의존 없음 |
| `aggregator.rs` 5개 struct | `device_id: String` 필드 추가 | L14-63 |
| `aggregator.rs` 5개 on_conflict | `device_id` 추가 | L360/367/375/383/391 |
| `aggregator.rs` read_* 시그니처 | `device_id: &str` 전파 | L83/140/195/258 + `sync_aggregates_now` L343 |
| Supabase 마이그레이션 `0017` | 5개 테이블 device_id 컬럼 + PK 재정의 | 신규 |
| `useUsage.ts:56-57` 주석 | 갱신만 | 동작 변경 없음 |
| **RPC 16개** | **변경 없음** | §3 감사 근거 |
| **프론트 SELECT 3곳 + 그 외** | **변경 없음** | §3 감사 근거 |

frontend(`auth.ts`/`App.tsx`/`Settings.tsx`)는 device_id 를 알 필요 없음 → **무변경** (device_id 는 Rust 내부에서 생성·주입).

---

## 3. 조회 경로 감사 — 왜 reader 를 안 고쳐도 되는가 (근거)

device_id 가 PK 에 추가되면 같은 `(user_id, date, source)` 에 기기별 여러 행이 생긴다. 모든 reader 가 이를 자동 합산함을 확인했다.

### 3.1 RPC 16개 — 전부 안전 (needsChange 0건)
모두 집계 차원(`user_id` / `mcp_server` / `plugin_id` / `tool_name` / `team_id` / `(user_id,date)` / `(user_id,hour_utc)`)으로 **GROUP BY + SUM** 하고, profiles/team_members join 은 `user_id` 1:1 이라 fan-out 곱 없음. LIMIT/TOP-N 은 전부 집계 후 적용. 확인된 RPC: `get_top_users`(0010), `get_weekly_top10`(0009), `get_top_mcp_servers`/`get_top_plugins`(0009), `get_user_mcp`/`get_user_plugins`(0010), `get_user_tools`(0014), `get_team_aggregates`/`get_team_members_usage`(0012), `get_team_mcp`/`get_team_plugins`(0013), `get_directory`/`get_mcp_users`/`get_plugin_users`(0015), `get_company_usage_by_user`/`get_company_hourly_by_user`(0016).

### 3.2 프론트 직접 SELECT 3곳 — 전부 안전
- `fetchMyAggregatedPoints`(`useUsage.ts:70`) → `Dashboard.aggregateByPeriod` 가 `keyFn(p.ts)` 로 `tokens += ...` 누적 (모든 Point ts=자정이라 같은 날 device Point 들이 동일 키로 합쳐짐).
- `fetchUserDailyAggregates`(`teams.ts:175`) → `UserDashboard.aggregate` 가 date 키 Map 에 `+=` 누적 + KPI 루프 전체 누적.
- `fetchUserHourly`(`teams.ts:205`) → `UserDashboard.aggregateHourly` 가 localHour 키로 누적 (이미 source/model 멀티행을 합치는 중이라 device 추가도 동일 처리).
- `mcp_usage`/`plugin_usage`/`tool_usage` 는 프론트 직접 SELECT 없음 (RPC 전용).

### 3.3 갱신할 주석 1개
`useUsage.ts:56-57` 주석이 "PK 가 (user_id,date,source)라 디바이스 무관 자동 합산"이라 적혀 있음 → device_id PK 추가 후 전제가 바뀌므로 주석만 갱신 (동작은 다운스트림 합산으로 무사).

---

## 4. 상세 작업

### 4.1 로컬 device_id 생성·영속
- 위치: `dirs::config_dir()/madup-token-monitor/device.json` (또는 `device_id` 파일). `dirs` 는 이미 의존(`db.rs:6`).
- get-or-create: 파일 있으면 읽고, 없으면 uuidv4 생성·기록 후 반환.
- **데이터 삭제와 분리**: `commands.rs:103-114` `data_files()` 목록에 **포함하지 말 것**. 그래야 "로컬 사용량 데이터 삭제"(`delete_all_data`) 시에도 기기 정체성 유지 → 서버 집계의 디바이스 연속성 보존.
- `Cargo.toml` 에 `uuid = { version = "1", features = ["v4"] }` 추가.

### 4.2 aggregator.rs
- 5개 struct(`UsageAggregate` L14-23, `McpUsageRow` L25-31, `PluginUsageRow` L33-39, `ToolUsageRow` L42-48, `HourlyRow` L51-63)에 `device_id: String` 필드 추가.
- 각 row 생성부(L128 / L171 / L180 / L238 / L281)에서 `device_id` 채움.
- `read_usage_aggregates`(L83)/`read_tool_calls`(L140)/`read_usage_hourly`(L195)/`read_tool_usage`(L258) 시그니처에 `device_id: &str` 추가.
- `sync_aggregates_now`(L343) 본문 시작에서 `let device_id = get_or_create_device_id()?;` 취득 → 각 `read_*` 에 전달.
- on_conflict 문자열에 device_id 추가:
  - L360 `"user_id,date,source"` → `"user_id,date,source,device_id"`
  - L367 `"user_id,date,mcp_server"` → `+ ,device_id`
  - L375 `"user_id,date,plugin_id"` → `+ ,device_id`
  - L383 `"user_id,hour_utc,source,model"` → `+ ,device_id`
  - L391 `"user_id,date,tool_name"` → `+ ,device_id`
- `upsert<T: Serialize>`(L292-327)는 제네릭이라 변경 불필요 (struct 만 바꾸면 JSON body 자동 반영).

### 4.3 Supabase 마이그레이션 `supabase/migrations/0017_device_id.sql`
각 5개 테이블에 대해:
```sql
alter table <t> add column device_id text not null default 'legacy';
alter table <t> drop constraint <t>_pkey;
alter table <t> add primary key (<기존 PK 컬럼들>, device_id);
```
- 대상 PK: usage_aggregates `(user_id,date,source,device_id)`, usage_hourly `(user_id,hour_utc,source,model,device_id)`, mcp_usage `(user_id,date,mcp_server,device_id)`, plugin_usage `(user_id,date,plugin_id,device_id)`, tool_usage `(user_id,date,tool_name,device_id)`.
- RLS: 정책이 `user_id` 기반이라 영향 없음 (PostgREST upsert select 정책도 user_id 기준 그대로 동작).
- 기존 행은 default 로 `device_id='legacy'` 백필 (→ §6 복구 전략에서 처리).

### 4.4 프론트
- `useUsage.ts:56-57` 주석만 갱신. 그 외 변경 없음.

### 4.5 lib.rs
- device_id 를 frontend 에 노출(예: Settings 표시)할 거면 `get_device_id` command 추가 + `invoke_handler!` 등록(`lib.rs:93-112`). **MVP 는 불필요** (Rust 내부 주입).

---

## 5. 롤아웃 순서 & breaking change 주의

PostgREST upsert 의 `on_conflict` 는 **존재하는 unique 제약과 일치**해야 한다. 마이그레이션이 PK 를 4(±)열로 바꾸면:
- 신버전 앱(4열 on_conflict) → 새 PK 와 일치 ✓
- **구버전 앱(3열 on_conflict) → 일치하는 제약 없음 → upsert 에러 → sync 실패** (단, 데이터 손상은 아님. 그냥 실패).

→ 마이그레이션과 신버전 앱 릴리즈를 **함께** 진행. 자동 업데이트가 있으므로 대부분 수 시간 내 신버전 전환. 미전환 기기는 전환까지 sync 만 안 될 뿐(데이터는 어차피 기존에 덮어써지던 상태). 저사용 시간대에 적용 권장.

순서:
1. `0017` 마이그레이션 작성 → Studio/`supabase db push` 로 적용 (승인 후).
2. 신버전 앱 빌드 + Draft Release publish (auto-update 전파).
3. Slack 공지: "업데이트 후 **각 기기에서 앱 1회 실행**(자동 재sync)".
4. §6 복구.

---

## 6. 데이터 복구 전략 — **결정 필요**

업로드가 "전체기간 재업로드"(델타 아님)라, 신버전 전환 후 각 기기가 재sync 하면 과거치까지 자기 device_id 행으로 정확히 올라온다. 단 기존 `legacy` 행 처리가 관건:

- **문제**: 마이그레이션 후 기존 데이터는 `device_id='legacy'` 로 남음. 재sync 하면 그 "마지막 sync 기기"의 데이터가 real device_id 로 다시 올라와 **legacy 행과 이중 계상**된다.

**채택 (2026-06-05): 데이터 유지 + 본인 재sync 시 자동 정리.** (클린 슬레이트는 전원 공백 + 미참여자/머신교체자 손실 위험으로 폐기)

동작:
1. `0017` 은 기존 행을 `device_id='legacy'` 로 두고 **삭제하지 않음**.
2. 신버전 앱이 자기 기기 데이터를 real device_id 로 업로드(자기 행만 idempotent 교체).
3. **업로드 성공 직후**, 본인의 legacy 행만 지우는 `purge_my_legacy()`(security definer, `auth.uid()` 본인 행만) 1회 호출 — 로컬 one-time 플래그(`settings.json`)로 게이트. 업로드 실패 시 purge 안 함(legacy 유지 → 안전).

효과:
- 앱 연 사용자: legacy 제거 + 실제 기기 데이터 → 정확. 다기기는 각 기기 열 때마다 합산. 과거(6/1~6/5)도 교정.
- 앱 안 연 사용자: legacy 유지 → **오늘과 동일(무손실)**.
- 전원 공백 없음, 영구 손실 없음. 엣지(맥 교체 후 새 맥에서 열면 옛 legacy 정리)는 안내로 커버.

→ production 데이터 **삭제 없음**. `purge_my_legacy` RPC 만 추가(본인 행 한정).

---

## 7. 검증 기준 (단계별)

- [ ] **device_id 안정성**: 앱 재시작 후 동일 device_id 반환. `delete_all_data` 후에도 유지(파일이 data_files 제외 확인).
- [ ] **다기기 합산**: 서로 다른 device_id 2개로 같은 `(user_id,date,source)` upsert → 두 행 공존 → `select sum(total_tokens) ... group by user_id,date` 가 합산값.
- [ ] **단일기기 무영향**: 한 기기 반복 sync 시 자기 행만 idempotent 갱신(중복 없음).
- [ ] **DB 대조**: 복구 후 skpark `usage_aggregates` 합 vs 본인 ccusage(기기별) 총합 일치 확인. supabase-cli-agent 로 쿼리.
- [ ] **화면**: 본인 Dashboard + 관리자 UserDashboard 90일 차트가 합산값 표시.
- [ ] **RPC 회귀**: `get_top_users(7,10)` 등 주요 RPC 결과가 기대 합산과 일치 (device 행 증가에도 정상).
- [ ] **구버전 차단 확인**: 구버전 앱 sync 가 (예상대로) 실패하고 데이터는 손상되지 않음.
- [ ] `pnpm build` + `cargo build` 통과, `pnpm tauri build` 로컬 검증(사용자 직접).

---

## 8. AWS 이관 정합성

`feature/aws-migration`(보류 중, Supabase 완전 제거 예정)의 PG 스키마·동기화 코드에도 **동일한 device_id 설계를 반영**해야 한다. 그렇지 않으면 이관 후 같은 버그가 재발한다.
- 현재 Supabase 가 운영 중이고 사용자가 실제 영향받으므로, 이 fix 는 **Supabase(main) 에 먼저 적용**.
- 이관 재개 시 AWS PG 스키마(device_id PK)와 sync 코드에 같은 변경을 포팅하는 작업을 백로그에 등록.

---

## 9. 미결정 / 승인 필요 항목

1. **복구 전략 (A) 클린 슬레이트 vs (B) legacy 유지** — production 데이터 삭제(A) 승인 여부 (§6).
2. **device_label(hostname) 동반 업로드 여부** — 사람이 읽는 라벨. 키 아닌 부가 컬럼. hostname 에 실명 포함 관행(`dilee-macbook`) → 익명화 원칙과 상충 가능. **보수적 기본: device_id(uuid)만, label 보류.** (§ 조사 노트)
3. **device_id frontend 노출 여부** — Settings 에 "이 기기" 표시할지. MVP 제외.
4. **마이그레이션 적용 타이밍** — 저사용 시간대 + 신버전 동시 릴리즈 (§5).

---

## 10. 영향받는 파일

신규/수정:
- `supabase/migrations/0017_device_id.sql` (신규)
- `src-tauri/Cargo.toml` (uuid 의존)
- `src-tauri/src/aggregator.rs` (struct/on_conflict/시그니처/sync_aggregates_now)
- `src-tauri/src/db.rs` 또는 `commands.rs` (device_id get-or-create 헬퍼)
- `src/hooks/useUsage.ts` (주석 갱신만)
- (선택) `src-tauri/src/lib.rs` (`get_device_id` command — frontend 노출 시)

변경 없음 (감사 확인): RPC 16개 전부, `src/lib/teams.ts`, `src/pages/Dashboard.tsx`, `src/pages/UserDashboard.tsx`, `src/lib/auth.ts`, `src/App.tsx`, `src/pages/Settings.tsx`.

---

## 부록 — 조사 노트 (device_id 저장 위치 trade-off)

- (a) SQLite meta 테이블: 단순하나 `delete_all_data` 가 db 통째 삭제 → device_id 도 리셋 → 디바이스 연속성 끊김.
- (b) config_dir 전용 파일 (**권장**): 데이터 삭제와 분리, 재설치 견고.
- (c) hostname: 변동·충돌 가능 → 불변 키로 부적합. 사람이 읽는 라벨로만 적합.
- uuid 직접 의존이 없으므로 `uuid` 크레이트 추가 필요(또는 getrandom 기반 자체 생성).
