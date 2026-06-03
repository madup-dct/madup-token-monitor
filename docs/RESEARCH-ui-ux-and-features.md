# 연구 — UI/UX 개선 + 추가 기능/화면 (Claude 기준 토큰 모니터링)

> 작성: 2026-05-29 · 상태: 연구 산출물 (코드 변경 없음, 구현 가이드용)
> 방법: 코드베이스 화면 감사(16개 컴포넌트) + 외부 벤치마크(Anthropic/ccusage/Helicone/Langfuse/Datadog/Vantage 등) + 기능 아이디에이션 + **어드버서리얼 완전성 검증**.
> 모든 제안은 실제 `file:line` 근거 + 실현가능성 등급(frontend-only / RPC / Rust / DB-migration)을 명시한다.
> §7 의 "검증으로 정정된 주장"을 먼저 읽으면, 초기 감사가 틀렸던 항목을 헛 구현하지 않는다.

---

## 0. Executive Summary

이 앱(`madup-token-monitor`)은 이미 동급 사내 도구 중 **앞서 있는 영역**이 많다 — 개인 로컬 집계, OAuth 5h/주간 한도 게이지, 일/주/월/시간 차트, MCP·플러그인 TOP, 사내 리더보드, 팀 집계, 자동 차트 타입 전환(45pt+ → line), CSV/클립보드 export, mock 미리보기. Anthropic Console조차 "개인 사용자 단위 분석 미지원"이라 **per-user 리더보드는 우리가 우위**다.

하지만 "**모니터링 시스템**"으로서 빠진 1순위 축이 셋 있다:

1. **능동 경고(Alert)** — 한도/예산 도달 시 *알려주는* 기능이 전무. 게이지는 보여주지만 사용자가 직접 열어봐야만 안다. 상시 노출되는 **트레이가 이 앱 최대 차별점**인데 트레이는 오늘 비용 텍스트만 보여준다.
2. **수집됐는데 안 쓰는 데이터** — `seven_day_sonnet`/`seven_day_opus` OAuth 한도는 이미 백엔드까지 흐르는데 화면에 없다. `usage_events.project`, `message/session_count`도 로컬엔 있으나 미노출.
3. **데이터 갭** — `usage_hourly` 테이블은 만들었지만 aggregator가 안 쓴다(서버 시간 해상도 0). `usage_aggregates`엔 model 차원이 없어 사내 모델별 분해 불가.

그리고 **정확도 버그 4건**(델타 자기참조, y축 눈금 좌표 역전, weekLabel 음수 인덱스, 평균 일일 토큰 기간 불일치)이 데이터 신뢰도를 직접 훼손한다 — 모니터링 도구에서 가장 먼저 고쳐야 할 부류.

권고 우선순위: **Phase 0 정확도 버그 + 회귀 테스트 → Phase 1 Quick wins(대부분 frontend-only, 수집된 데이터 노출 + 능동 경고) → Phase 2 Rust/정리 → Phase 3 DB 마이그레이션(model 차원·시간 적재).**

---

## 1. 현재 상태 감사 (US-001)

각 화면: 목적 / 강점 / UX 갭(요약) / 근거. 버그성 갭은 §5·§7과 교차 참조.

### 1.1 Dashboard (개인 대시보드, `src/pages/Dashboard.tsx`)

가장 큰 화면 — 오늘 KPI 히어로 / 사용량 한도 카드 / 기간별 사용량(4축 제어) / 활동 carousel / 주·월 미니카드 + 도구·모델 TOP.

| 영역 | 강점 | 핵심 갭 (근거) |
|---|---|---|
| 오늘 KPI | 48px 대형 숫자 + 7d 대비 δ 배지, USD/KRW 병기 | δ가 "오늘 vs 7일 평균"인데 7일 평균에 **오늘이 포함되어 자기참조 왜곡** (`Dashboard.tsx:332`); "활성 사용자 1/기기 1대" 하드코딩 슬롯 (`:504`) |
| 한도 카드 | OAuth/추정/오류 3상태 배지, QuotaSegBar 신호색 | 오류 메시지가 title 툴팁에만 숨음 → 460px에서 접근성 낮음 (`:553`); 월간 누적 분모 15B 임의상수 미고지 (`:351`); 헤더·카드 새로고침 버튼 중복 (`:591`) |
| 기간별 사용량 | granularity×range×metric×view 4축, 45pt+ 자동 line 전환 | hourly 선택 시 range Select가 말없이 사라짐(오늘 고정 안내 부재) (`:626`); Legend가 cost 모드에도 "Tokens" 고정 (`PeriodChartCard.tsx:145`) |
| 활동 carousel | 자동/수동 네비 + 히트맵·MCP·Plugin 3면 | **수동 조작해도 autoRotate가 안 꺼져** 보던 패널이 5초 뒤 사라짐 (`:679`); MCP/Plugin은 7일 고정인데 히트맵은 8주 → 기간 혼재 |
| 미니 카드/TOP | calendar 주/월 정확, 비용 내림차순 | 도구·모델 카드 기간 7d 하드코딩(변경 불가) (`:223`); 파일 끝 `__kpi_card_in_use` dead export (`:1043`) |

### 1.2 사내/팀 계열

**CompanyDashboard (전사 탭, `CompanyDashboard.tsx`)** — KpiHero 4종 + 3기간 prefetch 리더보드 carousel + 행클릭 드릴다운. 강점: prefetch로 전환 지연 0, PrismCarousel reduced-motion 폴백. 갭: 사이드 카드에 **"로컬 · 전사 RPC 준비 중" 미완성 문구가 실서비스에 노출** (`:379`); RingMeter 분모 2000건 하드코딩 (`:215`); MCP/Plugin TOP은 30일 고정이라 상단 period(오늘/주/월)와 불일치 (`:59`); DotGrid 16칸 초과 시 무음 잘림 (`:497`).

**TeamHub (탭 라우터, `TeamHub.tsx`)** — role 기반 탭 필터 + URL searchParams. 갭: `company` 탭만 패딩 다르게 마운트 (`:74`); `ALL_TABS`에 manager/admin min이 있으나 필터는 team_leader만 처리(향후 분기 미구현) (`:30`).

**MyTeamPanel** — KPI 30일 고정인데 아래 carousel은 오늘/주/월 → 기간 불일치 (`:158`); autoRotate가 native checkbox라 CompanyDashboard 커스텀 토글과 외형 불일치 (`:140`); carousel prev/next·dot 없어 자동회전에만 의존 (`:180`).

**CrossTeamPanel** — 30일 고정·기간선택 없음 (`:9`); 토큰 열엔 막대 없고 비용 열만 있음 (`:44`); 팀 이름 클릭 시 무동작(비교 후 액션 단절) (`:34`).

**TeamManageList vs TeamManagePanel — 중복 (No-Duplicate UI 규칙 위반).** 팀 생성·초대·멤버목록 세 기능이 두 컴포넌트에 복제(`TeamManagePanel.tsx:38`, `TeamManageList.tsx:74`). Settings·TeamHub 두 진입점이 공존해 사용자가 어디서 관리할지 혼란 (`Settings.tsx:474`, `TeamHub.tsx:80`). 둘 다 멤버 제거/역할 변경 UI 부재(초대만 가능) (`TeamManageList.tsx:287`); 슬러그 클라이언트 검증 없음 (`:125`).

**Leaderboard** — 4컬럼 정렬·본인 강조·검색·필터합계. 갭: 본인 매칭이 `display_name.includes()` 부분문자열 → 오발동 가능, **user_id 매칭이 안전** (`Leaderboard.tsx:182`); 검색 clear(×) 버튼 없음; 필터 합계에 "필터 결과" 라벨 부재.

**PrismCarousel** — reduced-motion crossfade 폴백·hover 일시정지. 갭: `onIndexChange`가 익명 함수면 부모 리렌더마다 interval 재생성 (`:45`); radius 600px 하드코딩.

### 1.3 유저상세 / 설정 / 로그인 / 사이드바

**UserDashboard** — KpiHero·PeriodChartCard·RankListCard 공유 컴포넌트 올바르게 재사용(No-Duplicate 준수), 1년치 1회 fetch 후 클라 집계. 갭: KPI 30일 고정 vs 차트 7/30/90·주·월 → 불일치 (`:248`); 직접 URL 진입 시 순위 "—" 빈 카드가 버그처럼 보임 (`:267`); `navigate(-1)` 뒤로갈 히스토리 없을 때 탈출 (`:248`); `KRW_RATE=1370` 하드코딩 (`:28`).

**Settings** — Card num/eyebrow/title 계층, SwitchRow `role=switch`, DangerRow 2단계 확인, role 게이트. 갭(중요): **카드 번호가 01→02→03→05→06→04→05로 04가 05 뒤·05 중복** (`:474`); Card/SwitchRow/Notice/InfoRow/DangerRow가 파일-로컬 정의이고 `ui/card.tsx`와 별도 Card 공존 → **No-Duplicate 위반**; 역할 라벨이 영문(`user/team_leader/...`) 그대로 노출(한국어 UI 불일치); "새 버전 알림(준비 중)" 스위치가 동작 안 하는데 활성 노출 (`:428`); 로그아웃이 Settings·Sidebar 두 곳에 다른 시각으로 존재.

**Login** — FloatingChip 가치제안, Spinner 로딩, Privacy 섹션, deep-link 책임 분리. 갭: FloatingChip가 `calc(50%±380px)` 절대위치 → **460px 폭에서 화면 밖/겹침** (`:93`); 로그인 클릭 후 `setLoading(false)` 즉시 호출 → 콜백 대기 중 버튼 재활성·중복클릭 가능, "브라우저에서 완료하세요" 안내 부재 (`:43`); 장식용 KeyChip(⌘?, ⌘⇧D)이 실제 단축키 미연결 (`:311`); 인라인 `<style>` keyframes (`:319`).

**Sidebar** — mc-nav-item active 전환, role 배지 조건부, initials 폴백 아바타. 갭: 그룹 헤더 "Personal"/"Team" 영문 하드코딩(아이템은 t() 번역하면서 헤더만 누락) (`:122`); team_leader/manager/admin **동일 배지색**이라 위계 구분 불가 (`:15`); 26px 버튼 2개에 되돌릴 수 없는 로그아웃이 확인 없이 즉시 실행 (`:208`).

### 1.4 디자인 시스템 일관성 (§9 부록 상세)

- **`hp-card-flat`이 정의 없이 team 패널에서 9회 사용** → Tailwind가 무음 누락. `mc-card`로 정규화 필요 (`index.css` 미정의, `MyTeamPanel.tsx:107`).
- **`App.css`에 Vite 템플릿 잔여**(`input,button{background:#fff;color:#0f0f0f}`)가 살아 있어 mc-* 버튼과 충돌 가능 (`App.css:63`).
- **KpiCard(48px) vs KpiHero(40px) 중복** — 같은 패턴 다른 크기. §8 표엔 KpiHero만 등록 → KpiCard 흡수 대상.
- **`html.theme-light` 토큰 블록이 완비**되어 있으나 ThemeToggle은 제거됨(`index.css` 라이트 토큰은 dead, 진입점 없음). 삭제는 요청 시.
- `RingMeter`는 CompanyDashboard 1곳만 사용 + 분모 하드코딩.

---

## 2. 외부 베스트프랙티스 벤치마크 (US-002)

검증된 사실 위주(공식 문서 직접 확인). 우리가 **이미 가진 것**과 **없는 것(weLack)**을 구분.

### 2.1 Anthropic 네이티브 & Claude Code 생태계

| 출처 | 기능 | 우리 보유? |
|---|---|---|
| Anthropic Console Cost | 일별 지출 + Workspace/모델별 + **도구(web search/code exec) 비용 분리** + CSV | 모델 분해·도구별 비용 ✗ |
| Usage & Cost Admin API | 1분/1시간/1일 버킷, **inference_geo·speed·service_tier** group_by | 차원 분류 ✗ |
| Claude Code `/cost` v2.1.92+ | **모델별 비용 분해**, cache hit rate, rate-limit 사용률 | 모두 ✗ |
| ccusage `--breakdown` | 모델별 세분화, **15+ 에이전트 통합**(Codex/Gemini CLI 등) | 모델 분해·타 에이전트 ✗ |
| ccusage `blocks` | **5h 빌링 윈도우 블록**(Active/Completed/Gap) + **burn rate** + Projected 토큰 | ✗ (5h 게이지만 있음) |
| ccusage statusline | 활성 5h 블록 비용+잔여시간, burn rate | 트레이 텍스트로 일부 대체 |
| VS Code Usage Tracker | **Sonnet/Opus 주간 할당량 분리** 게이지, 색상 인코딩, 호버 상세 | 모델별 분리 ✗ |
| Claude Code statusline | `context_window.used_percentage`(컨텍스트 소진율) | 개념 ✗ |
| Claude Max/Pro 한도 | 5h 롤링 + 7일 캡(전체+Sonnet 별도) | 5h/주간 게이지 ✓, Sonnet 분리 ✗ |
| Claude-Code-Usage-Monitor | **ML burn rate 예측 + 한도 도달 예상시각** | ✗ |

**시사점:** Claude 특화 영역에서 가장 큰 미흡은 ① 모델별 분해 ② 5h burn rate / 한도 도달 예측 ③ Sonnet/Opus 한도 분리. ①③은 데이터가 이미 있거나 갭이 작다(§3).

### 2.2 LLM Observability / FinOps 플랫폼

| 출처 | 기능 | 이식 가치 / 비고 |
|---|---|---|
| Helicone | **Budget Alert 50/80/95%** 단계 | Tauri notification/Slack webhook으로 구현. (Helicone 2026.3 Mintlify 인수) |
| Helicone | **Cache hit rate + "이번 달 $X 절감"** | 데이터 이미 있음 → KPI 즉시. 난이도 낮음 |
| Datadog/Vantage | **이상치(anomaly) 탐지** | 사내 수십 명 규모엔 z-score/IQR로 충분(ML 불요) |
| Langfuse | 비용 임계값 알림(Slack/PagerDuty) — **로드맵 단계** | 우리가 먼저 구현 시 우위 |
| Vantage | **비용 예측(Forecast)** | 7일 이동평균×남은일수로 "이달 예상 $X" |
| LiteLLM/Bifrost | 4단계 예산 hard stop | 호출 차단은 scope 밖, 소프트 알림만 |
| Braintrust/Atlan | Slack/PagerDuty webhook, **주간 리포트(이메일/Slack)** | Slack OIDC 인프라 이미 보유 |
| FinOps/Langfuse | **프로젝트/feature 태깅** 비용 분류 | `usage_events.project` 이미 적재 → 노출만 |

**시사점:** 공통적으로 **예산/알림·이상치·예측·캐시 절감·태깅**을 핵심으로 본다. 우리는 시각화는 강하나 *능동성(알림)*과 *예측*이 비어 있다.

### 2.3 대시보드 UX (460×760 메뉴바 popover 제약)

- **데이터 freshness 라벨**("N초 전 갱신") — 혼합 refresh 주기 앱에서 신뢰도 핵심. 현재 카드 단위 없음.
- **빈 상태/온보딩** — Claude Code 미설치/0건 시 그냥 0 표시 → 신규 동료가 "고장났나" 오인. CTA 빈 상태 필요.
- **예산 기준선 오버레이** — "월 예산 $X" 점선 + "이 속도면 월말 $X".
- **룰 기반 인사이트 한 줄** — "이번 주 최고 비용일: 화요일"(API 비용 0, 클라 계산).
- **색 단독 인코딩 회피(WCAG AA)** — 차트가 색만으로 계열 구분(적록색맹 8%). Legend shape 병용.
- **키보드 단축키** — Cmd+R 새로고침, Cmd+1~5 탭. 현재 전역 단축키 없음.
- **핀 KPI** — 사용자가 가장 신경쓰는 1지표 고정.
- 메뉴바 관습(클릭아웃 dismiss)은 충족 ✓.

---

## 3. 데이터 & 실현가능성 갭 분석 (US-005)

### 3.1 보유 vs 부족

**보유(지표):** input/output/cache_read/cache_write 토큰, total_tokens, cost_usd, cost_krw(로컬), message_count·session_count(로컬), MCP/plugin 호출수, OAuth 5h/7d/7d_sonnet/7d_opus utilization(로컬 메모리), 팀 member_count·total_tokens·total_cost(서버).

**보유(차원):** source, date(KST 자정), hour bucket(로컬), model(로컬), project(로컬), session_id(로컬), mcp_server, plugin_id, user_id(서버 RLS), team_id, range preset(today/7d/30d/90d/365d/all), app_role, team_member.role.

**핵심 데이터 갭(7):**

| # | 갭 | 근거 | 영향 |
|---|---|---|---|
| G1 | `usage_hourly`(0011)가 정의만 있고 **aggregator가 INSERT 안 함** | `aggregator.rs:15-246`(upsert 없음), `0011:26-38`(정의) | 서버 시간 해상도 0 — 팀/전사 시간별 차트 불가 |
| G2 | `usage_aggregates`에 **model 차원 없음** | `0001:38-46`(PK user_id,date,source), `0010:7`(주석) | 사내 모델별 분해 불가. usage_hourly PK엔 model 있으나 데이터 0이라 동일 |
| G3 | 서버에 cache_read/write 미적재 → total을 근사 역산 | `useUsage.ts:80-83`(cacheRemainder, cache_write=0) | 다중 디바이스 합산 뷰의 cache breakdown 부정확 |
| G4 | KRW 환율 외부 API 의존 + fallback 1,350 / 서버엔 KRW 컬럼 없음 | `pricing.rs:114,134` | 환율 급변 시 수% 오차; 사내 리더보드 항상 USD |
| G5 | message/session_count가 **서버 미적재** | `aggregator.rs:15-23`, `0001:38-46` | 리더보드에 활동 빈도 비교 불가 |
| G6 | `project` 차원 서버 미업로드 | `aggregator.rs:49-103`(project 무시) | 프로젝트별 비용 추적 로컬에서만 |
| G7 | OAuth usage 서버 미저장(메모리만) | `oauth_usage.rs:33` | 한도 추이/팀 단위 모니터 불가; 비공개 API 변경 위험 |

> **로그인 시 hourly granularity 정합성 이슈(중요):** `useTimeseries`가 로그인 상태에서 Supabase **일별** aggregates를 우선 사용한다(`useUsage.ts:60-113`). 반환 point의 `ts`가 전부 로컬 자정이라, Dashboard "시간별" granularity로 보면 모든 값이 **hour 0에 몰려** 사실상 무의미해진다. G1(서버 시간 적재)이 해결되기 전까지 hourly는 로컬-fallback(비로그인/서버 빈 경우)에서만 정상.

### 3.2 실현가능성 4계층 분류 (제안 → 등급)

| 등급 | 정의 | 해당 제안(§5/§6 ID) |
|---|---|---|
| **frontend-only** | React/훅만 수정 | U2,U3,U4,U5,U7,U10,U12,U13, F1,F2,F6,F9,F11 |
| **RPC** | Supabase SQL 함수 추가/수정 | F14, F16 |
| **Rust** | Tauri 백엔드(commands/aggregator/pricing) | U6(차트 useId), F3,F5,F7,F8,F15 |
| **DB-migration** | 스키마 변경(영향 큼) | F4(model 차원), F10(활동량), F13(주간 리포트) |

---

## 4. 제안 개요 (읽는 법)

구체 제안은 두 표로 나뉜다 — **§5 UI/UX 개선**(`U1~U21`, 기존 화면 다듬기)과 **§6 추가 기능/화면**(`F1~F16`, 신규 가치). 각 항목은 §3.2 의 4계층(frontend-only/RPC/Rust/DB-migration)으로 등급이 매겨져 있고, 우선순위 종합은 **§8 로드맵**(Phase 0~3)에서 한눈에 본다. 초기 감사가 틀렸던 항목은 **§7**에서 정정했으니, U1·F3·F12·F15를 구현하기 전 §7을 먼저 볼 것.

---

## 5. UI/UX 개선 제안 (US-003)

> P0=정확도/치명, P1=고가치, P2=품질, P3=장기. 공유 컴포넌트 확장으로 No-Duplicate 규칙 준수.
> **§7 검증 반영:** QuotaSegBar 100% "버그"는 실재하지 않음 → U1은 aria/role 추가로 재정의.

| ID | 제안 | P | 등급 | 공수 | 영향 파일 | 근거 |
|---|---|---|---|---|---|---|
| U1 | **QuotaSegBar 접근성** `role="meter"`+aria-valuenow/min/max+aria-label (※100% 버그는 없음, §7) | P1 | FE | S | `ui/QuotaSegBar.tsx` | 스크린리더 한도 전달 부재 |
| U2 | **오늘 vs 평균 델타 교정** — 분모를 `(sum7-today)/6`(직전 6일)로 + "직전 6일 평균 대비" 라벨 | P0 | FE | S | `Dashboard.tsx:332` | 자기참조 왜곡 |
| U3 | **차트 y축 눈금 좌표 역전 수정** `(i+1)/5`→top-down 정렬 + **호버 툴팁**(날짜·토큰·비용) | P0 | FE | M | `DailyBarChart.tsx:88`, `DailyLineChart.tsx` | 눈금↔막대 어긋남(신뢰도) + 정밀값 확인 수단 전무 |
| U4 | **avgDailyTokens 기간 정합**(30일 토큰 ÷ 30일 활동일). ※"weekLabel 음수 인덱스"는 비-버그로 확인(§7-6) | P0 | FE | S | `Dashboard.tsx:355` | 평균 과소산정 |
| U5 | 차트 gradient id를 `useId()`로 고유화 + **Sparkline `Math.random` id 제거** | P1 | FE | S | `DailyBarChart/DailyLineChart/Sparkline.tsx` | defs 충돌/누수 |
| U6 | "활성 사용자 1/기기" 슬롯 → **캐시 적중률 KPI**(`cache_read/(input+cache_read)`) | P1 | FE | S | `Dashboard.tsx:504` | 정보가치 낮은 슬롯 재활용(데이터 이미 있음) |
| U7 | 활동 carousel **수동 조작 시 autoRotate 즉시 off** + 타이틀 fade | P1 | FE | S | `Dashboard.tsx:679`, `PrismCarousel.tsx` | 보던 패널 사라짐 |
| U8 | PeriodChartCard **Legend를 metric에 따라 동적 라벨** + hourly 시 "오늘 24h" 칩 | P1 | FE | M | `dashboard/PeriodChartCard.tsx:145` | cost인데 "Tokens" 표기·range 사라짐 |
| U9 | **Settings 카드 번호 재배열(01~07 연속)** + "준비 중" 토글 disabled | P1 | FE | S | `Settings.tsx:474, 428` | 번호 혼란·헛스위치 |
| U10 | **OAuth 오류 inline 메시지 + 재시도 CTA**(title 툴팁 탈피) | P1 | FE | S | `Dashboard.tsx:553` | 핵심 데이터원 실패 인지 |
| U11 | **Settings 파일-로컬 Card/SwitchRow/Notice 등 공유 ui로 추출** | P1 | FE | L | `Settings.tsx`, `ui/card.tsx`, `ui/SwitchRow.tsx` | No-Duplicate 위반 |
| U12 | team 패널 **미정의 `hp-card-flat` → `mc-card` 정규화** | P1 | FE | M | `team/*.tsx` | 무음 스타일 누락 |
| U13 | **KPI 기간 명시** — KpiHero eyebrow에 적용 기간 항상 표기(+상단 period 통일 옵션) | P1 | FE | M | `UserDashboard/MyTeamPanel/CompanyDashboard.tsx`, `KpiHero.tsx` | KPI(30일)↔차트(가변) 불일치 |
| U14 | **중복 컴포넌트 정리** — KpiCard→KpiHero 흡수, RingMeter/`__kpi_card_in_use` dead 처리, KpiHero `colSpan` fallback 보완 | P2 | FE | M | `ui/KpiCard.tsx`, `ui/RingMeter.tsx`, `Dashboard.tsx:1043` | §8 규칙·크기 불일치 |
| U15 | **Select 키보드 내비**(↑/↓/Enter) + 뷰포트 경계 방향 전환 | P2 | FE | M | `ui/Select.tsx` | aria 선언 대비 키보드 미동작 |
| U16 | **빈 상태/온보딩 카드**(데이터 0 시 CTA) 공유 `EmptyState` | P2 | FE | M | `Dashboard.tsx`, `dashboard/EmptyState.tsx` | 신규 동료 오인 |
| U17 | **Sidebar 그룹헤더 i18n** + 역할 배지 위계별 색 + 로그아웃 확인 | P2 | FE | S | `Sidebar.tsx`, `i18n/ko.json` | 영문 하드코딩·위계 미구분·오터치 |
| U18 | **Leaderboard 본인 매칭 user_id 기반** + 검색 inline clear(×) + "필터 결과" 라벨 | P2 | FE | S | `charts/Leaderboard.tsx:182` | 부분문자열 오발동 |
| U19 | **Login FloatingChip 반응형 보정**(절대위치 → 460px 안전) + "브라우저에서 완료" 안내 + 장식 KeyChip 정리 | P2 | FE | M | `Login.tsx:93, 43, 311` | 화면 밖/중복클릭 |
| U20 | **TeamManageList↔TeamManagePanel 단일화** + 멤버 제거/역할변경 UI + 슬러그 검증 | P2 | FE | L | `team/TeamManage*.tsx`, `Settings.tsx:474` | 중복·관리 도구 미완 |
| U21 | 색 단독 인코딩 보완(Legend shape 병용·라벨) | P3 | FE | M | `charts/*`, `ui/Legend.tsx` | WCAG AA(과한 패턴 fill은 지양, §7) |

### Claude 특화 지표 반영 체크 (요구: 5+)
U6(cache 효율), §6 F1(5h burn rate), F2(Sonnet/Opus 한도 분리), F3(캐시 절감액), F4(model 분해), F11(KRW), U8(hourly) — 7+ 충족.

---

## 6. 추가 기능/화면 제안 (US-004)

> §7 검증 반영: F3(캐시 절감액)은 **frontend-only**로 정정(캐시 단가 이미 구현). pricing 보강(F15)은 **Fast mode/Opus4.7 토크나이저/Web search 건당**만 유효(캐시 단가는 이미 정확).

| ID | 기능 | 가치 | 데이터 소스 | 등급 | Claude특화 |
|---|---|---|---|---|---|
| F1 | **5h burn rate + 한도 도달 예상시각** | 한도 초과 전 페이스 조절. 트레이 상시노출과 궁합 | `oauth_usage` five_hour + 로컬 최근 N분 토큰증가(`commands.rs get_timeseries`) | FE | ✓ |
| F2 | **Sonnet/Opus 주간 한도 분리 게이지** | 이미 수집된 `seven_day_sonnet/opus`가 사장 중 — 노출만 | `oauth_usage.rs:22-23`(파싱됨, `useUsage.ts:156`까지 흐름) | FE | ✓ |
| F3 | **캐시 절감액 KPI**("이번 달 캐시로 $X 절감") | 비용 인식 제고·캐시 활용 독려 | `cache_read × input단가 × 0.9`(단가 이미 구현, §7) | FE | ✓ |
| F4 | **모델별 토큰/비용 분해**(opus/sonnet/haiku) | ccusage·Console 핵심. 로컬 by_model 있으나 서버 없음 | 로컬 `get_summary by_model`; 서버 `usage_hourly`(model 포함) 적재 + RPC group_by | DB | ✓ |
| F5 | **usage_hourly 서버 적재 + 사내/팀 시간대별 트렌드** | G1 해소. "팀이 몇 시에 쓰는지" + hourly를 서버로 확장 | `aggregator.rs`에 upsert 추가(로컬 시간버킷 재사용) → `usage_hourly`(정의 존재) | Rust | — |
| F6 | **월 예산 + 차트 기준선 + 월말 예상비용** | 비용 가시성/통제. API 비용 0 | `set_setting`(`commands.rs:75`) + get_summary + DailyLineChart threshold prop | FE | — |
| F7 | **비용/한도 임계치 알림**(트레이 뱃지/색 + Tauri notification) | 능동 경고 — 모니터링 1순위. 트레이가 최대 차별점 | `oauth_usage`+`get_today_cost_usd`+Settings 임계치+notification plugin/`tray.rs` | Rust | ✓ |
| F8 | **프로젝트별 비용 드릴다운(로컬)** | `usage_events.project` 이미 적재, 노출 전무 | `commands.rs get_summary`에 by_project + RankListCard 재사용 | Rust | — |
| F9 | **룰 기반 자동 인사이트 한 줄** | "최고 비용일·전주 대비·최다 MCP" 스캔 효율 | get_summary/timeseries/top_mcp — 전부 클라 계산 | FE | — |
| F10 | **활동량 지표(message/session_count) 서버 집계** | 토큰/비용 외 활동 빈도 비교 | `commands.rs:187`(로컬) → usage_aggregates 컬럼 + RPC 확장 | DB | — |
| F11 | **팀/전사 카드 KRW 병기 + 환율 freshness** | 국내 사내 맥락. 서버는 USD뿐 | `pricing.rs` 환율(+`FxCache.fetched_at:91`) + 클라 변환 | FE | ✓ |
| F12 | **export 범위 확대** (※Dashboard엔 이미 clipboard+CSV 구현, §7) | 현재 Dashboard 일별만 → UserDashboard/Company/Team + 모델/프로젝트 단위로 | 각 화면 집계 + 공유 export 유틸 추출 | FE | — |
| F13 | **주간 사내 리포트 → Slack**(선택) | Slack OIDC 인프라 활용. Langfuse도 로드맵 | pg_cron+Edge Function+Slack webhook(Settings 저장) | DB | — |
| F14 | **이상치 플래그**("전주 대비 +50% 사용자") | 비용 급증 조기 인지(z-score, ML 불요) | 신규 RPC `get_usage_anomalies` → Leaderboard 배지 | RPC | — |
| F15 | **pricing 보강** — Fast mode 할증·Opus4.7 토크나이저·Web search 건당 (※캐시 단가는 이미 정확) | 최신 가격표 정확도 | `pricing.rs calc_cost_usd` + 단가표 확장 | Rust | ✓ |
| F16 | **CompanyDashboard 더미 제거 → 전사 모델/시간 RPC 연결** | "전사 RPC 준비 중" 미완성 문구 제거 | F4·F5 후 `get_company_breakdown` → `CompanyDashboard.tsx:379` | RPC | — |

---

## 7. 어드버서리얼 검증으로 정정된 주장 (정확도 보증)

초기 감사/아이디에이션이 **틀렸던 항목** — 직접 코드 재확인(fresh evidence)으로 정정. 이걸 모르면 **헛 구현**한다.

1. **QuotaSegBar "100% 빈 바 버그" — 실재하지 않음.** `clamped=1.0` → `full=12`, 렌더 루프 `if(i<full)`(=`i<12`)이 `i=0..11` 모두 참 → 12개 전부 풀컬러(`QuotaSegBar.tsx:41-61` 직접 확인). `full=Math.min(floor,segments)` 클램프는 **no-op**. → U1은 **aria/role 추가만** 유효(P1로 하향).
2. **pricing.rs 캐시 단가 — 이미 정확히 구현.** cache_read 0.1x / 5m 1.25x / 1h 2.0x(`pricing.rs:72-74`), parser가 5m/1h 분리 파싱. → "캐시 분리·1h 2x 미반영"은 거짓. F3(절감액)은 **frontend-only**(새 Rust 필드 불필요), F15는 Fast mode·토크나이저·Web search만 남음.
3. **CSV/클립보드 export — 이미 구현.** `Dashboard.tsx:370` `copyDailyToClipboard`(navigator.clipboard) + `:380` `exportCsv`(Blob+download). 리서치의 "clipboard 코드 grep 미발견(high confidence)"은 **오판**. 진짜 갭 = **적용 범위**(타 화면·모델/프로젝트 단위 export 부재) → F12로 재정의.
4. **"활성 사용자 정보가치 0" — 과한 평가.** 개인 로컬 대시보드에선 1이 자연스럽고 다중 디바이스 합산 시 의미가 생긴다. U6은 "제거"보다 "캐시 효율로 재해석".
5. **월간 분모 15B 임의상수** — 갭은 사실이나 분모 자체를 개선하는 제안이 빠져 있었음 → F2(Sonnet/Opus 분리)·F1(burn rate)로 한도 카드 고도화 시 함께 재설계 권장.
6. **weekLabel "음수/중복 인덱스" — 비-버그(검증관 false positive).** Phase 0 구현 중 어드버서리얼 검증관이 "KST 실제 버그"로 재판정했으나, 실제 `weekStartKey`는 `localDateKey`(로컬)를 쓴다(`Dashboard.tsx:54-58`) — 검증관이 evidence로 든 `toISOString`은 코드에 없다. 검증관이 UTC 버전을 손수 옮겨 node 재현한 false positive. `fillWeeklyGaps`가 월내 로컬 월요일만 넘기므로 weekIdx≥1·고유 → 수정 불필요. (적대적 verdict 도 실제 코드로 검증해야 함을 재확인.)

**(검증이 추가로 부각한 누락, §critique):** 예산 알림이 모니터링 1순위인데 과소평가됨 → **F7을 P1로**; 트레이 자체 개선(아이콘 색/뱃지/우클릭 메뉴) 제안 부재 → F7에 포함; 데이터 freshness 라벨 미반영 → F11/U10과 함께; **P0 수치 수정(U2/U3/U4)엔 회귀 테스트 필수**(`pricing.rs`에 `test_calc_cost*` 패턴 존재).

---

## 8. 우선순위 로드맵 (US-006)

| Phase | 성격 | 항목 | 등급 |
|---|---|---|---|
| **Phase 0 — 정확도/신뢰 (먼저)** | 데이터 신뢰 직결 버그 + 회귀 테스트 | U2(델타), U3(y축+툴팁), U4(weekLabel·평균), U5(gradient id), U1(aria) | FE, 각 S~M |
| **Phase 1 — Quick wins** | 대부분 FE, 수집된 데이터 노출 + 능동성 | F2(Sonnet/Opus 게이지), F1(burn rate), F3(캐시 절감), U6(캐시 효율), F6(예산+기준선), F9(인사이트 한줄), F11(KRW freshness), U7,U8,U10,U13, F12(export 확대), **F7(트레이 알림, Rust 경량)** | FE 중심 |
| **Phase 2 — 정리 & 백엔드 경량** | 일관성·Rust | U9,U11,U12,U14,U15,U16,U17,U18,U19,U20, F5(usage_hourly 적재), F8(프로젝트 드릴다운), F15(pricing 보강) | FE/Rust |
| **Phase 3 — Big bets** | DB 마이그레이션·서버 | F4(model 차원), F10(활동량 집계), F16(전사 RPC), F14(이상치 RPC), F13(주간 Slack, 선택) | RPC/DB |

**Phase 간 의존:** F4·F16은 F5(usage_hourly 적재) 선행. F1·F2는 독립(데이터 이미 있음) → 가장 빠른 고가치. F7(알림)은 capabilities에 notification plugin 추가만 필요.

**의도적 보류(ROI/맥락 부적합, §critique infeasible):**
- 5h **블록 리포트 풀테이블**(ccusage) → 460px compact엔 정보 과밀. F1(burn rate 한 줄)로 충분.
- **이상치 ML** → 수십 명 표본엔 오탐. F14(단순 전주 대비 배지)로 한정.
- **주간 Slack 자동 리포트**(F13) → pg_cron/Edge Function 운영 부담. webhook URL 받는 수동 공유부터.
- 차트 fill **패턴**(U21) → 미니차트 노이즈. Legend shape 병용 정도.

---

## 9. 부록 — 디자인시스템 일관성 노트 (`.claude/CLAUDE.md §8` 연계)

- **즉시 정규화:** `hp-card-flat`(미정의·9회 사용) → `mc-card`. `App.css` Vite 잔여 제거. KpiCard→KpiHero 흡수. `__kpi_card_in_use` dead export 제거. Settings 파일-로컬 Card/SwitchRow → `ui/`.
- **No-Duplicate 재발 방지:** §8의 자체검증 grep(`function Kpi|Legend|Segmented`, `<select`)을 pre-PR 체크/CI로 승격. team 컴포넌트 단일화(U20) 후 §8 표 갱신.
- **theme-light:** 토큰 블록은 완비됐으나 진입점 없음(dead). 다크 단일 유지가 결정이면 §12에서 항목 정리 + 토큰 삭제(요청 시), 라이트 부활이면 토글 재도입.
- **접근성 토큰:** 중간톤(text-tertiary/faint) 대비비 4.5:1 점검, Legend/QuotaSegBar/RingMeter에 aria.

---

## 부록 B — 근거 인덱스 (대표)

- 자기참조 델타 `Dashboard.tsx:332` · y축 역전 `DailyBarChart.tsx:88` · weekLabel `Dashboard.tsx:66` · 평균 기간 `Dashboard.tsx:355`
- QuotaSegBar(버그 없음) `ui/QuotaSegBar.tsx:41-61` · pricing 캐시단가 `pricing.rs:72-74` · export `Dashboard.tsx:370-396`
- usage_hourly 미적재 `aggregator.rs:15-246` vs `0011:26-38` · model 차원 부재 `0001:38-46` · hourly 로그인 이슈 `useUsage.ts:60-113`
- OAuth Sonnet/Opus 미노출 `oauth_usage.rs:22-23` · FxCache.fetched_at `pricing.rs:91`
- 중복 팀 컴포넌트 `TeamManagePanel.tsx:38`/`TeamManageList.tsx:74` · Settings 카드번호 `Settings.tsx:474` · hp-card-flat `MyTeamPanel.tsx:107`
