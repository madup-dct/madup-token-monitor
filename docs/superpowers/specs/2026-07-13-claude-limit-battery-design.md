# Claude 한도 배터리 표시 (5h / 7d / Fable) — 디자인 스펙

- 날짜: 2026-07-13
- 요청 배경: Fable 사용으로 토큰 소모가 커져 한도를 다 쓰는 경우가 잦음.
  잔여량과 **리셋 시각**을 앱에서 바로 확인해, 필요 시 계정 쉐어 요청 판단에 활용.
- 범위: **대시보드 한도 패널 + 트레이 메뉴바 + 계정 한도 페이지(팀 공유, Supabase)**
  — 팀 공유까지 이번 스펙에 통합 확정 (2026-07-13 논의)

## 배경 — 현재 상태와 문제

- 대시보드 캐러셀의 Claude 한도 패널(`UsageLimitPanel.tsx`)은 5시간/주간 **사용률 %** 와
  상대 리셋 시간("2시간 후 초기화")만 표시.
- **Fable 주간 한도가 표시되지 않음**: Anthropic OAuth usage API(`api.anthropic.com/api/oauth/usage`)가
  응답 구조를 변경해 모델 scoped 주간 한도는 새 `limits` 배열
  (`kind: "weekly_scoped"`, `scope.model.display_name: "Fable"`)로만 내려옴.
  기존 top-level 필드 `seven_day_opus` / `seven_day_sonnet` 은 이제 `null`.
- 색상 임계값은 사용률 기준 40%/80% — 요청안(잔여 70%/30%)과 다름.

## 요구사항

1. 5h / 7d(모든 모델) / Fable 주간 한도 표기. ~~잔여 %(배터리)~~ →
   **숫자·게이지 채움은 사용률 %** (2026-07-14 실사용 피드백으로 변경 — 클로드
   사용량 페이지와 동일 의미, 트레이·패널·계정 한도 전 표면 통일).
   신호색·정렬·상태 점은 잔여 기준 유지.
2. 색상: 잔여 ≥70% 초록 / 40~70% 주황(systemOrange) / <40% 빨강 (2026-07-14 임계값
   30→40 + 주황화). 여유(초록) 상태도 상시 표시. 트레이는 **배터리 셀** 아이콘으로 표시
   (중립 트랙 + 상태색 채움 + nub — 옆 메뉴바 아이콘과 톤 통일). 계정 한도 페이지는
   창(5h/7d/Fable)별 초기화 시각을 각자 표기.
3. **리셋 시각** 표기 (절대 시각, KST).
4. 트레이 메뉴바에도 잔여 % 상시 표시 (별도 토글).
5. **팀원별(정확히는 계정별) 한도 공유** — 같은 Claude 계정을 여러 명이 나눠 쓰는
   현실을 반영해, 계정 단위 잔여/리셋을 Supabase 로 공유하고 사이드바 "계정 한도"
   페이지에서 열람 → "이 계정 쉐어해 주세요" 요청 판단 지원.

## 1. 데이터 계층 (Rust — `src-tauri/src/oauth_usage.rs`)

새 `limits` 배열을 파싱해 창(window) 목록으로 일반화한다.

```rust
pub struct LimitWindow {
    pub kind: String,               // "session" | "weekly_all" | "weekly_scoped"
    pub scope_model: Option<String>, // weekly_scoped 일 때 모델 표시명 (예: "Fable")
    pub utilization: f64,           // 사용률 % (0~100 클램프)
    pub resets_at: String,          // RFC3339
}

pub struct OAuthUsage {
    pub windows: Vec<LimitWindow>,
    pub fetched_at: String,
    pub is_stale: bool,
}
```

- 파싱 우선순위: `limits` 배열 → 비어 있거나 없으면 **legacy 필드
  (`five_hour`/`seven_day`/`seven_day_sonnet`/`seven_day_opus`)에서 fallback 합성**
  (`five_hour`→`session`, `seven_day`→`weekly_all`, sonnet/opus→`weekly_scoped`+모델명).
- `limits` 항목 중 percent 또는 resets_at 이 없는 항목은 제외. 알 수 없는 `kind` 는
  그대로 전달 (프론트가 라벨 fallback 처리).
- 향후 새 모델의 scoped 창이 추가되면 코드 수정 없이 자동 표시.
- 캐시(10분)·429 백오프·토큰 조달 로직은 기존 그대로 유지.
- **단위 테스트**: 실제 응답 축약 fixture 로 (a) `limits` → `windows` 매핑과 Fable 추출,
  (b) legacy fallback 합성, (c) percent 클램프를 검증.

## 2. 트레이 (`src-tauri/src/tray.rs` + 설정)

- 새 설정 `show_menubar_limits` (기본 off) — 기존 `show_menubar_cost` 와 동일한
  저장/읽기 패턴. Settings 페이지에 토글 1개 추가.
- **표현 방식: 상태 문자열 전체를 이미지로 렌더해 트레이 아이콘으로 교체**
  (macOS 트레이 타이틀은 일반 텍스트뿐이라 색 표현 불가. 이모지는 너무 커서 제외 —
  사용자 피드백).

  ```
  [로고] ●5h 8  ●7d 28  ●F 48   (● = 이미지 내 작은 원, 3단계 상태색)
  ```

  - 한도 토글 on 이면: 로고 + 점 + **사용률 숫자**(+ 비용 토글 on 시 `$12`)를 **하나의
    이미지로 런타임 렌더** → `tray.set_icon()` 교체, 타이틀은 비움.
    (숫자는 사용률 % — 클로드 사용량 페이지의 "N% 사용됨"과 동일 의미. 잔여 표기에서
    2026-07-14 실사용 피드백으로 변경. 점 색은 잔여 기준 3단계 유지.)
    한도 토글 off 면 기존 동작(정적 로고 + `$N` 타이틀) 그대로.
  - 상태 점은 **여유(초록) 포함 3단계 모두 상시 표시**: 잔여 ≥70% 초록 / ≥30% 노랑 /
    <30% 빨강 — 패널 색상과 동일 규칙.
  - 트레이는 `windows` 전체를 API 순서대로 표기 (현재 3창: 5h/7d/Fable.
    향후 scoped 창이 늘면 자동 포함).
  - 라벨: `session`→`5h`, `weekly_all`→`7d`, `weekly_scoped`→모델명 첫 글자 (Fable→`F`).
  - 렌더 구현: 폰트 래스터라이저(`ab_glyph` 또는 `fontdue`) + 임베드 폰트로 RGBA 버퍼에
    직접 드로잉. 숫자/라벨 텍스트 색은 메뉴바 테마(다크/라이트) 감지해 흰색/검정 전환,
    상태 점은 고정색.
  - 다크모드 감지는 폴링 스레드가 갱신하는 캐시(`defaults read`) 경유 — 렌더 경로에서 블로킹 조회 금지.
  - **구현 리스크**: Retina 스케일(1x/2x)에서 흐림·크기 문제가 날 수 있음.
    해결이 어려우면 fallback — 텍스트는 일반 타이틀로 두고 아이콘에 상태 점 3개만 합성.
  - macOS 외 OS 는 기존처럼 tooltip 에 텍스트로 동일 내용 (`5h 92% · 7d 72% · F 52%`).
- **비블로킹 원칙**: `refresh_tray_title` 은 OAuth 캐시 **읽기 전용** 헬퍼
  (`cached_oauth_windows()`)만 사용 — watcher 가 파싱 직후 호출하는 경로에서 네트워크
  블로킹 금지. 네트워크 갱신은 기존 30초 폴링 스레드(`spawn_title_updater`)가
  `get_oauth_usage_impl(false)` 를 호출해 10분 캐시 만료 시에만 수행
  (기존 `refresh_other_devices_cost_if_stale` 패턴과 동일).
- 리셋 시각이 지난 창·토큰 없음 → 해당 창(또는 한도 파트 전체) 생략.

## 3. 대시보드 한도 패널 (`src/components/dashboard/UsageLimitPanel.tsx`)

- `ClaudeLimits` 는 `usage.windows` 를 순서대로 렌더.
  라벨: `session`→"5시간 한도", `weekly_all`→"주간 한도",
  `weekly_scoped`→"주간 · {모델명}", 알 수 없는 kind→kind 문자열 그대로.
- `LimitRow` 를 배터리 의미로 전환:
  - 행 앞에 **3단계 상태 점**(CSS 원, 이모지 아님): 잔여 ≥70% 초록 / ≥30% 노랑 /
    <30% 빨강 — 여유 상태도 초록 점으로 상시 표시.
  - 숫자: **사용률 %** (정수 반올림) — 예: "사용 52%" (2026-07-14 변경, 요구사항 1 참조).
  - 세그먼트 바(`QuotaSegBar`): 사용률만큼 채움 (usage meter). 색은 잔여(1-value) 기준.
  - 색상(`quotaSignal`): 입력을 **잔여 비율**로 재정의 —
    잔여 ≥0.7 lime / ≥0.3 amber / <0.3 coral.
  - 리셋: `리셋 07/14 00:59` (로컬 tz = KST, `MM/DD HH:mm`) 표기,
    hover `title` 로 상대 시간("2시간 후") 제공. 리셋 경과·stale 이면 "갱신 대기" 유지.
- `CodexLimits` 도 같은 `LimitRow` 를 사용하므로 자동으로 동일한 잔여 표기/색상으로 통일
  (No-Duplicate UI 규칙 — 인라인 재정의 금지).
- 프론트 타입(`useRateLimits.ts` 의 `OAuthUsage`)과 mock(`buildMockOAuthUsage`)을
  새 `windows` 구조로 갱신 — 브라우저 dev 모드에서 육안 확인 가능하게 5h/7d/Fable 3창 mock.

## 4. 팀 공유 — 계정 한도 (Supabase + 사이드바 새 페이지)

### 4.1 개념 모델 — 한도는 "계정" 단위

- 팀은 같은 Claude 계정을 여러 명이 나눠 쓰고, 기기의 로그인 계정도 수시로 바뀐다.
  따라서 한도 스냅샷의 주체는 **앱 유저(profile)가 아니라 Claude 계정**.
- 로컬 계정 식별: `~/.claude.json` 의 `oauthAccount.emailAddress` + `accountUuid`
  (이 기기에서 OAuth usage API 가 반환하는 한도가 속한 계정). 검증 완료 — 두 필드 존재.
- 같은 계정으로 로그인한 기기가 여러 대여도 같은 row 를 upsert → last-write-wins 가
  정확하다 (계정 단위 값이므로 다기기 합산 문제 없음).

### 4.2 Supabase 스키마 (마이그레이션 — supabase-cli-agent 경유)

```sql
-- 계정별 최신 한도 스냅샷
create table claude_limit_snapshots (
  account_uuid   uuid primary key,          -- oauthAccount.accountUuid
  account_email  text not null,             -- oauthAccount.emailAddress
  windows        jsonb not null,            -- [{kind, scope_model, utilization, resets_at}]
  fetched_at     timestamptz not null,      -- 로컬에서 API fetch 한 시각
  uploaded_by    uuid references profiles(id),
  updated_at     timestamptz not null default now()
);

-- 계정 → 소유자 수동 매핑 (예외 케이스용)
create table claude_owner (
  account_email  text primary key,
  owner_email    text not null
);
```

- **소유자 결정 규칙**: ① `claude_owner` 에 매핑이 있으면 그 값 →
  ② 없으면 `account_email` == profiles 이메일 자동 매칭 →
  ③ 둘 다 없으면 계정 이메일 그대로 표시.
  (계정 대부분이 사내 이메일이라 자동 매칭으로 충분, 공용/개인 이메일 계정만
  `claude_owner` 로 오버라이드. v1 관리는 Supabase 직접 INSERT — 관리 UI 없음.)
- RPC `get_claude_account_limits()`: snapshots + 소유자 결정 규칙 + profiles 표시명
  조인 반환. RLS: 로그인 유저 select.
- 업로드는 **security definer RPC** (`upsert_claude_limit_snapshot`) 경유 —
  같은 계정 row 를 여러 유저(같은 계정을 나눠 쓰는 팀원들)가 갱신해야 하므로
  row 소유 기반 RLS 로는 성립하지 않음.
- 날짜 버킷 없음 → `kst_today()` 이슈 해당 없음 (`resets_at` 은 timestamptz 그대로).

### 4.3 업로드 (주기)

- **동의 토글 없음 — 로그인한 모든 사용자가 항상 업로드** (2026-07-13 기획 확정.
  리더보드 `share_consent` 와 무관. 사내 도구 + "쉐어할 계정 찾기" 유스케이스가
  전원 가시성을 전제로 하므로 의도적 결정 — 재플래그 금지).
- 주기: 기존 aggregator sync 사이클에 편승 — OAuth usage 캐시(10분)가 갱신됐고
  계정 이메일을 읽을 수 있을 때만 upsert. 실패는 조용히 skip (다음 사이클 재시도).
- 업로드 실패 시 5분 쿨다운 — 쿨다운 동안 재시도 skip (무백오프 연속 재시도 방지).

### 4.4 계정 한도 페이지 (사이드바 "계정 한도" 신설)

- 라우트/네비 신설. 테이블 한 줄 = 계정 하나:

  ```
  ● 홍길동 (hong@madup.com)   5h ▮▮▮ 92 · 7d ▮▮ 72 · F ▮ 52   리셋 07/16 11:59 · 3분 전 갱신
  ```

  - 행 앞 상태 점 = 세 창 중 **최저 잔여** 기준 색 (패널과 동일 3단계).
  - 각 창은 미니 게이지 바(`QuotaSegBar` 재사용) + 사용률 % (2026-07-14 통일).
  - 리셋 시각은 가장 임박한 창 기준 절대 시각(KST), hover 로 창별 상세.
- 정렬: 기본 **Fable 잔여 많은 순** (쉐어 요청할 계정이 위로). `Segmented` 로
  5h/7d/F 정렬 기준 전환.
- 마지막 갱신 30분 초과 행은 흐리게 + "N시간 전 갱신" 표시 (죽은 데이터 오인 방지).
- 공유 컴포넌트 규칙 준수: `QuotaSegBar`/`Segmented`/상태 점은 패널과 같은 정의 재사용,
  인라인 재정의 금지. 새로 추출하는 공유 컴포넌트는 CLAUDE.md §8 표에 등록.

## 5. 에러 / 엣지 처리

- `utilization` 은 0~100 클램프 (음수/100 초과 방어).
- `resets_at` 파싱 실패 또는 과거 시각 → 해당 행 "갱신 대기" (패널) / 생략 (트레이).
- OAuth 토큰 없음 → 패널은 기존 에러 문구 유지, 트레이는 한도 파트 생략.
- `is_stale`(429 백오프) → 마지막 캐시 값 그대로 표시 (기존 동작 유지).
- `~/.claude.json` 없음 / `oauthAccount` 없음 → 팀 공유 업로드만 skip
  (로컬 표시는 정상 동작).

## 6. 검증

- `cargo test` — oauth_usage 파싱 테스트 통과.
- `pnpm build` — 프론트 타입/빌드 통과.
- `pnpm dev` (mock) — 패널 배터리 표기·색상·리셋 시각, 계정 한도 페이지 육안 확인.
- Supabase 마이그레이션/RPC 적용·검증은 `supabase-cli-agent` 위임 (우회 금지 룰).
- 실기기 확인(`pnpm tauri dev` / `pnpm tauri build`)은 사용자가 직접 수행
  (자동 빌드/커밋 트리거 금지 룰).

## 범위 제외 (명시)

- 이모지 상태 표시 — 크기 문제로 제외 (사용자 피드백). 트레이는 이미지 렌더,
  패널/계정 한도 페이지는 CSS 상태 점으로 대체.
- Codex 트레이 표시 — 트레이는 Claude 창만. (패널의 Codex 행 표기 통일은 포함.)
- `claude_owner` 매핑 관리 UI — v1 은 Supabase 직접 관리, 필요 시 후속.
- 쉐어 요청 자동화(Slack 알림 등) — 열람까지만. 요청은 사람이 직접.
