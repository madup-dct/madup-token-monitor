# CLAUDE.md — 프로젝트 컨텍스트 (AI 이어받기용)

> 이 파일은 새로운 Claude 세션이 프로젝트를 빠르게 이해하기 위한 단일 entry point.
> 코드 변경 시 항상 최신 상태 유지. 외부 시스템 설정은 `docs/` 의 개별 문서를 참고.

## 0. 프로젝트 한 줄 요약

`madup-token-monitor` — 매드업 사내 동료를 위한 macOS 메뉴바(트레이) 팝오버 앱.
Claude / Codex / Gemini 등 AI CLI 도구의 토큰 사용량과 비용을 로컬에서 집계하고,
옵트인한 사용자만 익명화된 합계를 사내 리더보드 + 팀 채팅으로 공유.

- **로컬 우선**: 원시 메시지/프롬프트는 디바이스를 떠나지 않음. 토큰 카운트 + 비용만 옵션으로 업로드.
- **단일 플랫폼**: macOS (Apple Silicon + Intel). Windows 는 v0.2 이후 검토.
- **사내 도구**: GitHub Releases 자동 업데이트.

## 1. 기술 스택

| 영역 | 선택 |
|---|---|
| 데스크톱 셸 | Tauri 2 (Rust + WKWebView) |
| 프론트엔드 | React 19 + Vite 7 + TypeScript 5.8 + Tailwind v4 |
| 라우팅/상태 | react-router-dom v7, zustand, @tanstack/react-query (persist) |
| i18n | react-i18next (현재 ko 만) |
| 차트 | recharts |
| 백엔드(BaaS) | Supabase (Auth + Postgres + Realtime + RPC) |
| 인증 | Slack OIDC (Supabase Auth provider) |
| 로컬 DB | SQLite (rusqlite) |
| 패키지 매니저 | pnpm 11 |
| Node | 24 (engines.node 강제) |
| 릴리즈 | 로컬 빌드 + `gh release` (CI 미사용 — `scripts/release.sh`) |

## 2. 디렉토리 구조

```
madup_token_monitoring/
├── .claude/                # AI 컨텍스트 (이 파일)
├── scripts/release.sh      # 로컬 릴리즈 (빌드·서명·latest.json·gh release)
├── docs/                   # 외부 시스템 설정 가이드
│   ├── auth-callback/      # GitHub Pages 의 OAuth success 페이지
│   ├── index.html          # GitHub Pages 진입
│   ├── AUTO_UPDATE_SETUP.md
│   ├── SLACK_APP_SETUP.md
│   ├── SUPABASE_SETUP.md
│   └── GITHUB_SECRETS.md
├── src/                    # 프론트엔드
│   ├── App.tsx             # BrowserRouter + DeepLinkBridge + AggregateSyncDriver + SupabaseSessionBridge + Layout
│   ├── pages/              # Dashboard, MCP, Plugins, Leaderboard, Chat, Settings, Login, Profile
│   ├── components/
│   │   ├── ui/             # 디자인시스템 1차 (Select, card, tabs)
│   │   ├── charts/         # recharts 래퍼
│   │   └── chat/           # 채팅 메시지 + 입력
│   ├── hooks/              # useUsage, useDashboardUsage, useRateLimits, useAuthUser, useMessages
│   ├── lib/                # supabase, auth, AuthGuard, format, usage-sources
│   ├── i18n/               # ko.json + index.ts
│   └── types/              # models.ts (Range, Point, Summary, Profile 등)
├── src-tauri/
│   ├── Cargo.toml          # name = "tauri-app" (binary 이름이 됨)
│   ├── Info.plist          # CFBundleURLTypes (deep link scheme 명시 — 자동 주입 누락 방지)
│   ├── tauri.conf.json     # productName, plugins.deep-link.desktop.schemes, updater pubkey/endpoint
│   ├── capabilities/default.json  # core/opener/autostart/deep-link 권한
│   └── src/
│       ├── lib.rs          # Builder + plugin 등록 + tray setup
│       ├── tray.rs         # 메뉴바 아이콘 + popover 위치 + spawn_title_updater
│       ├── commands.rs     # tauri::command (get_timeseries, get_heatmap, get_today_cost_usd, ...)
│       ├── summary.rs      # source별 get_summary 집계
│       ├── codex_limits.rs # Codex rollout의 최신 rate_limits 집계
│       ├── db.rs           # SQLite 스키마 + range_bounds("1d"|"7d"|"30d"|"365d"|"all")
│       ├── parser.rs       # JSONL 파서 façade 및 공통 chunk 처리
│       ├── parser/         # claude.rs, codex.rs, opencode.rs provider 파서
│       ├── watcher.rs      # 파일 워처 (tokio + notify)
│       ├── aggregator.rs   # Supabase 집계 업로드 (sync_aggregates_now)
│       ├── pricing.rs      # 모델별 단가 테이블
│       ├── plugins.rs      # 플러그인 사용 집계
│       └── oauth_usage.rs  # Anthropic 비공개 endpoint (5h/7d 한도)
├── supabase/migrations/    # SQL 스키마 + RPC (get_top_users, get_top_mcp, get_top_plugins, ...)
└── package.json            # version 이 빌드/태그의 single source of truth (tauri.conf.json 도 동일하게 유지)
```

## 3. 외부 시스템 한눈에 보기

| 시스템 | 역할 | 설정 문서 |
|---|---|---|
| Supabase | Auth, Postgres, Realtime, RPC | `docs/SUPABASE_SETUP.md` |
| Slack | OIDC OAuth provider (사내 워크스페이스) | `docs/SLACK_APP_SETUP.md` |
| GitHub Pages | OAuth success 리다이렉트 페이지 | `docs/auth-callback/` (브랜치: main, 폴더: docs/) |
| GitHub Releases | 로컬 빌드 산출물 배포 (CI 미사용, `scripts/release.sh`) | `docs/AUTO_UPDATE_SETUP.md` |
| Tauri Updater | GitHub Releases 기반 자동 업데이트 | `docs/AUTO_UPDATE_SETUP.md` |

> **Supabase DB 직접 작업(SELECT / RPC / 마이그레이션 / RLS)은 `.claude/agents/supabase-cli-agent.md` 로 위임 — 우회 금지.**
> psql(pooler) 접속 레시피·전체 스키마/RPC 카탈로그·안전 게이트가 그 agent 에 정리돼 있다. 연결값은 `supabase/.temp/`(gitignore) + `~/.pgpass` 에서 읽는다.

## 4. 빠른 셋업 (개발자)

```bash
# 1) Node 24 + pnpm 11 + Rust 설치 (rustup default stable)

# 2) 의존성
pnpm install --dangerously-allow-all-builds

# 3) .env (gitignored). docs/SUPABASE_SETUP.md 와 GITHUB_SECRETS.md 를 보고 동일한 값 채움
cat > .env <<EOF
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxxxxxxxxxxx
VITE_AUTH_SUCCESS_URL=https://madup-dct.github.io/madup-token-monitor/auth-callback/
EOF

# 4) 개발 모드 (vite dev + tauri dev — 별도 창에서 webview 실행)
pnpm tauri dev
# 또는 frontend 만
pnpm dev    # http://localhost:1420

# 5) 로컬 production 빌드 (서명 키가 있어야 dmg 까지 완성)
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/madup-token-monitor.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD='<생성 시 입력했던 비밀번호>'
pnpm tauri build
# 결과물: src-tauri/target/release/bundle/{macos/madup-token-monitor.app, dmg/*.dmg}
```

## 5. 빌드 / 릴리즈 흐름

**로컬 릴리즈** — GitHub Actions(macOS 러너) 비용 폭주로 CI 빌드를 폐지했다.
빌드·서명·업로드를 전부 로컬에서 수행. (`build.yml`/`release.yml` 삭제됨.)

```bash
# 1) 코드 변경 + version 일치
#    package.json + src-tauri/tauri.conf.json 둘 다 동일한 SemVer 로 갱신 후 commit
# 2) 서명 키 export (docs/AUTO_UPDATE_SETUP.md 1.1/1.2)
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/madup-token-monitor.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD='<생성 시 비밀번호>'
# 3) 로컬 릴리즈 스크립트 — macOS aarch64 + x86_64 빌드·서명 + latest.json 조립 +
#    .dmg ×2 / .app.tar.gz ×2 / *.sig / latest.json 을 Draft Release 로 업로드
bash scripts/release.sh
# 4) 검증 후 `gh release edit v0.1.x --draft=false` 로 publish
#    publish 시점에 latest.json 이 .../releases/latest/download/latest.json 으로 노출 →
#    기존 설치 사용자의 자동 업데이트 활성화
```

> Windows(nsis) 는 macOS 에서 빌드 불가 → 현재 배포는 macOS 2종만. Windows 배포가 다시 필요하면
> Windows 머신에서 별도 빌드하거나 CI 를 부분 복구해야 한다.

## 6. 알려진 함정 (이미 학습한 것)

이 항목들은 한 번씩 시간을 잡아먹은 영역. 새 fix 시 다시 회귀하지 않도록 주의.

### 6.1 Tauri 2 macOS deep link
- **`tauri.conf.json` 의 `plugins.deep-link.desktop.schemes` 만으로 Info.plist 가 자동 채워지지 않는 빌드가 있음.**
  → `src-tauri/Info.plist` 에 `CFBundleURLTypes` 를 명시. Tauri 가 base 로 받아 빌드 시 merge.
- **`tauri-plugin-deep-link::get_current` 는 capability 권한 필요.**
  → `src-tauri/capabilities/default.json` 의 `permissions` 에 `"deep-link:default"`,
    `"deep-link:allow-get-current"` 모두 등록.
- **`DeepLinkBridge` 의 `useEffect` 에 `[navigate]` 를 deps 로 두면 라우트 변경마다 재실행되어
  `getCurrent()` 가 반복적으로 같은 OAuth callback URL 을 처리.** 사용자가 탭 이동 시 Dashboard 로
  강제 이동하는 버그를 만든다.
  → `navigate` 를 `useRef` 로 우회 + `deps = []` + 처리한 URL 을 `Set` 에 기록.

### 6.2 Supabase
- **PKCE / implicit flow 둘 다 처리 가능해야 한다.**
  `src/lib/auth.ts` 의 `handleAuthCallback` 이 fragment(`#access_token=...`) 우선 + query(`?code=...`)
  fallback 으로 처리.
- **Slack OIDC 의 redirectTo 는 deep link 가 아니라 https success page** 가 가장 자연스럽다.
  - `madup-token-monitor://auth/callback` 으로 직접 redirect 하면 브라우저 탭이 무한 로딩으로 멈춘다.
  - GitHub Pages 의 `docs/auth-callback/index.html` 이 fragment 를 받아 deep link 로 forward + window.close.
  - `.env` / GitHub Secret 의 `VITE_AUTH_SUCCESS_URL` 가 그 페이지를 가리켜야 한다.
- **publishable key 종류 주의.**
  Supabase Dashboard 의 `Project Settings → API Keys` 에서 **anon public** 또는
  **Publishable key (`sb_publishable_...`)** 만 사용. `service_role` / `Secret key` 는 절대 클라이언트로
  나가면 안 된다 (RLS 우회 위험).
- **로컬 `.env` 과 GitHub Secret 이 다르면 "Invalid API key" 무한 로딩.** `.env` 로 로컬은 동작하지만
  CI 빌드는 다른 키로 inject 되는 케이스가 한 번 있었음.
  → 확정 fix 는 `printf '%s' "$KEY" | gh secret set ...` 으로 줄바꿈 없이 등록.

### 6.3 Tauri Updater
- **`createUpdaterArtifacts: true` 에서는 `TAURI_SIGNING_PRIVATE_KEY` + `..._PASSWORD` 가
  CI 환경변수에 반드시 있어야 한다.** 없으면 빌드 마지막 서명 단계에서 실패.
- **public 키와 private 키 비밀번호 불일치는 "Invalid signing private key password" 로 빌드를 멈춘다.**
  키 회전 시 `tauri.conf.json` 의 `pubkey` 와 GitHub Secret 의 비밀번호를 동시에 갱신.

### 6.4 GitHub Actions / vite secret inject (⚠️ 과거 기록 — CI 빌드 폐지됨)
> 비용 폭주로 `build.yml`/`release.yml` 삭제, 릴리즈는 `scripts/release.sh` 로컬 전환.
> 아래는 CI 를 다시 도입할 경우를 위한 학습 기록.
- **`tauri-apps/tauri-action@v0` 가 step `env:` 의 `VITE_*` 를 sub-process 로 forwarding 하지 않는
  케이스가 있다.**
  → workflow 에 `Write .env` step 을 추가해 secrets 를 명시적으로 `.env` 파일로 떨어뜨려야 vite 가
    `import.meta.env.*` inline 한다. `release.yml` / `build.yml` 모두 동일 패턴.
- **secret 등록 명령이 끝의 줄바꿈을 같이 저장할 수 있다** (terminal paste). `printf '%s'` 를 stdin 으로
  파이프하는 게 안전.
- **pnpm 11 의 CI 모드는 `Ignored build scripts` 를 치명적 에러로 처리.**
  → `pnpm install --frozen-lockfile --dangerously-allow-all-builds` 사용. `.npmrc` 에도
    `dangerously-allow-all-builds=true` 백업.

### 6.5 macOS Gatekeeper
- 사내용이라 Apple Developer ID 서명 / notarization 을 안 한다. 그래서 동료들이 처음 설치 시
  "손상된 파일" 경고를 본다.
- 회피: `xattr -cr /Applications/madup-token-monitor.app`. README / Slack 공지에 안내.
- 자동 업데이트로 갱신된 버전은 quarantine 상속받지 않으므로 첫 설치만 거치면 OK.

### 6.6 React 7 + 라우팅
- 메뉴바 popover 는 1개 윈도우라 `BrowserRouter` 를 그대로 사용. 라우트 가드는 `AuthGuard` 가
  `Layout` 외곽에서 처리. `/login` 에 머물면서도 user 가 truthy 가 되면 `Login` 페이지의 useEffect
  로 `/` 로 navigate (이전 v0.1.11 commit 에서 검증).

### 6.7 헤더 드래그 (popover 윈도우 이동)
- macOS popover + `decorations: false` 환경에서 `data-tauri-drag-region` 이 의도대로 작동하지 않아
  현재는 의도적으로 비활성화. 트레이 위치에 고정되어 보여주는 것이 자연스럽다.

### 6.8 신규 모델 출시 시 pricing.json 키 누락 → cost $0 적재
- 단가표(`src-tauri/pricing.json`)에 없는 모델은 `calc_cost_usd` 가 0 을 반환해
  로컬·Supabase 모두 비용 0 으로 집계된다 (2026-06 claude-fable-5 사고: 전사 7명 ~$600 누락).
- **새 Claude/GPT/Gemini 모델 출시 시 pricing.json 에 키 추가 + 세대 generic 키 유지**
  (예: `claude-fable`). `pricing.rs` 에 회귀 테스트 패턴 있음.
- `db.rs::recalc_zero_cost_events` 가 앱 시작 시 cost=0 이벤트를 현재 단가표로 소급 보정
  → 단가 추가 후 릴리즈하면 각 기기 로컬 DB 가 자동 치유되고 다음 sync 가 Supabase 를 덮어쓴다.
  Supabase 직접 UPDATE 는 금물 — hourly sync(최근 30일, merge-duplicates 치환)가 되돌린다.

### 6.9 Supabase RPC 날짜 경계는 `kst_today()` — `current_date`(UTC) 금지
- 날짜 버킷(`usage_aggregates.date` 등)은 클라이언트가 KST 달력 날짜로 만들지만
  Supabase Postgres 세션 tz 는 UTC. RPC 필터에 `current_date` 를 쓰면 KST 00~09시
  사이 "오늘"이 전날로 계산돼 전일 데이터가 합산 표시된다 (2026-07-03 발견,
  0021 에서 집계 RPC 16개 일괄 교정).
- **새 RPC 에서 날짜 경계가 필요하면 `kst_today()`(0021 정의) 사용.**
  `usage_hourly.hour_utc`(timestamptz) 비교는 KST 자정을 변환:
  `hour_utc >= timezone('Asia/Seoul', (kst_today() - (N || ' days')::interval))`.
- 로컬 SQLite 쪽 `db.rs::range_bounds` 는 `chrono::Local` 자정 기준 — 양쪽 정의를
  항상 일치시킬 것.

### 6.10 Codex rollout 파싱 및 dedup
- Codex 최신 rollout 은 `event_msg` 안의 `payload.type=token_count`와
  `payload.info.last_token_usage`를 사용한다. 누적 `total_token_usage`는 dedup identity로만
  사용하고, 실제 집계는 요청별 `last_token_usage`를 합산한다.
- `input_tokens`에는 캐시 입력이 포함되므로 `input_tokens - cached_input_tokens`를 일반 입력으로
  저장하고 캐시 입력은 `cache_read`로 분리한다. 음수·불일치 usage는 저장하지 않는다.
- fork된 subagent rollout에 복사된 부모 turn은 제외하고, child 자신의 turn부터만 집계한다.
- GPT-5.6 Codex 모델(`gpt-5.6-sol/terra/luna`) 단가는 `src-tauri/pricing.json`에 공식 가격 기준으로
  등록한다. 새 모델 추가 시 `pricing.rs` 회귀 테스트도 함께 갱신한다.

## 7. 데이터 흐름 (요약)

```
~/.claude/projects/**/*.jsonl, ~/.codex/sessions/**/*.jsonl, ~/.gemini/**
  ↓ (watcher.rs: notify crate)
parser.rs → parser/{claude,codex,opencode}.rs → usage_events table (SQLite)
  ↓ get_summary (summary.rs) / get_timeseries / get_heatmap / get_top_* (commands.rs)
React (useUsage.ts) → Dashboard / MCP / Plugins
  ↓ (5분 주기 + 사용량 변경 이벤트(60초 throttle) + 수동 sync)
aggregator.rs → Supabase usage_aggregates / mcp_aggregates / plugin_aggregates
  ↓ Supabase RPC (get_top_users, get_top_mcp, get_top_plugins, get_weekly_top10)
Leaderboard / Plugins (사내 집계 view)
```

`usage_events` 의 `(message_id, request_id)` UNIQUE INDEX 로 dedup.
`get_today_cost_usd` 는 트레이 메뉴바 옆 텍스트 갱신용.
`sync_aggregates_now` 는 증분 업로드 — `sync_state` 의 MAX(id) 워터마크로 변경분이 건드린
dirty 버킷만 upsert, 변경 없으면 네트워크 생략. cost 소급 보정(recalc)·tool 재분류 시 워터마크
리셋 → 전체 재업로드. 계정 전환 시(SYNC_LAST_USER 불일치)도 전체 백필. Settings 수동 동기화는
force=전체 백필 (원격 드리프트 복구 수단).
⚠️ usage_events/tool_calls 를 **삭제**하는 기능을 추가하면 `sync_state` 도 같이 비울 것 —
rowid 재사용으로 워터마크가 신규 이벤트를 영구 누락시킨다 (id 는 AUTOINCREMENT 아님).

## 8. 코드 컨벤션

- **언어**: 응답 한국어. 코드 변수/함수/파일/커밋 메시지는 영어. 주석은 "왜" 가 한국어로 명확하면 OK.
- **Tailwind**: `hp-*` utility (예: `hp-card-flat`, `hp-eyebrow`, `hp-display-lg`) 가 디자인 토큰.
  새 컴포넌트는 이 utility 를 우선 활용.
- **색**: `--canvas`, `--cloud`, `--ink`, `--charcoal`, `--graphite`, `--primary`, `--primary-soft`,
  `--hairline` 등 (CSS variables). hex 직접 사용 지양.
- **i18n 키**: `dashboard.cards.totalTokens` 같이 페이지/그룹/이름 3 depth.
- **버전**: SemVer. `package.json` 과 `src-tauri/tauri.conf.json` 두 곳을 항상 동시에 갱신.
- **커밋**: Conventional Commits (`feat`, `fix`, `chore`, ...). 본문에 "왜" + "어떻게".
- **Co-Authored-By**: Claude 가 만든 커밋엔 footer 에 명시 (rules/team-workflow 와 일치).
- **공유 컴포넌트 일관성 (No-Duplicate UI 규칙)** — 같은 시각/UX 의 컴포넌트는
  한 곳에만 정의하고 모든 페이지에서 import. 새 페이지에서 비슷한 UI 가 필요해도
  인라인으로 다시 만들지 말 것. 인라인을 발견하면 공유 컴포넌트로 마이그레이션:

  | 용도 | 공유 컴포넌트 | 사용처 (현재) |
  |---|---|---|
  | KPI 카드 (eyebrow + 큰 숫자 + context) | `@/components/dashboard/KpiHero` | Dashboard, CompanyDashboard, UserDashboard, MyTeamPanel |
  | 기간별 사용량 카드 (chart/list 토글 + Tokens/Cost + Copy + Legend) | `@/components/dashboard/PeriodChartCard` | Dashboard, UserDashboard |
  | TOP 막대 순위 리스트 (랭크 글리프 + gradient 막대) | `@/components/ui/RankBarList` | Dashboard, UserDashboard, CompanyDashboard |
  | 페이지넘김 carousel 카드 (헤더 회전 제목 + 화살표/점/자동토글) | `@/components/dashboard/CarouselCard` | Dashboard, UserDashboard |
  | 차트 범례 (square / dot / line / dashed) | `@/components/ui/Legend` | Dashboard, PeriodChartCard |
  | 2~4 옵션 inline 토글 | `@/components/ui/Segmented` | 전역 |
  | 일자별 막대 차트 (SVG) | `@/components/charts/DailyBarChart` | PeriodChartCard 내부에서만 |
  | 일자별 라인 차트 (SVG, 45+ pts) | `@/components/charts/DailyLineChart` | PeriodChartCard 내부에서만 (chartType auto 분기) |
  | 리더보드 행 | `@/components/charts/Leaderboard` | CompanyDashboard, MyTeamPanel, TeamDashboardPanel |
  | 팀 대시보드 (KPI + 멤버 리더보드 + 팀 MCP/플러그인 carousel) | `@/components/team/TeamDashboardPanel` | 팀 관리 드릴다운 (TeamManageList) |
  | 전사 유저 테이블 (권한·팀·토큰 정렬/필터/검색, 행→상세) | `@/components/team/UserFilterTable` | AdminAnalytics (사용량 분석) |
  | 사용자 리스트 모달 (엔터티→사용자 + 사용량, 행→상세) | `@/components/team/UserListModal` | AdminAnalytics (사용량 분석) |
  | Carousel prism/slide primitive (저수준) | `@/components/ui/PrismCarousel` | CarouselCard 내부, UsageSourceCarousel, CompanyDashboard·MyTeamPanel |
  | "오늘" 카드 하단 stat (라벨+큰 숫자+보조) | `@/components/dashboard/TodayStat` | Dashboard, UserDashboard |
  | 미니 통계 카드 (eyebrow+큰 숫자+suffix+foot, colSpan) | `@/components/dashboard/MiniStatCard` | Dashboard, UserDashboard |
  | 활성 카운트 dot grid (KPI rightAccessory) | `@/components/ui/DotGrid` | CompanyDashboard, MyTeamPanel |
  | 캐러셀 컨트롤 (이전/점/다음 + 선택적 자동 토글) | `@/components/ui/CarouselControls` | UsageSourceCarousel, CompanyDashboard, MyTeamPanel |
  | 토큰 소스·계정 한도 캐러셀 | `@/components/dashboard/UsageSourceCarousel` | Dashboard (통합/Claude/Codex 전역 선택) |
  | Dropdown (single-select) | `@/components/ui/Select` | **모든 페이지** — native `<select>` 금지 |

  - **granularity(시간별/일자별/주별/월별) 컨트롤 컨벤션** — ambient 대시보드 카드는
    `CarouselControls`(자동 회전 포함), 분석 페이지(AdminAnalytics)는 `Segmented`(직접 선택).
    의도적 구분 — 통일 재제안 금지.
  - **플러그인 ID 표시는 `prettyPluginId`(lib/labels.ts) 경유** — Claude Code 가 절단한
    중복 ID("playwright_playwrig")를 정리. RankBarList 에는 `title`(원본) 함께 전달.

  - 다른 페이지에서 비슷한 컴포넌트가 필요하면 → **공유 컴포넌트의 prop 슬롯/variant 를 확장**.
  - 한 페이지에서만 의미 있는 UI 라도, **두 번째 페이지에서 비슷하게 필요해지는 순간 추출**.
  - 추출 시 위 표에 한 줄 추가.
  - 시각이 미세하게 달라야 하면 prop (e.g. `colSpan`, `shape`) 으로 흡수. variant 가 5개 넘으면 그때 분리 고려.
  - **자체 검증** — PR 직전:
    - `grep -rn "function Kpi\|function Legend\|function Segmented" src/` — 인라인 컴포넌트 신규 정의 없는지
    - `grep -rn '<select' src/` — native `<select>` 잔존 없는지 (전부 `Select` 컴포넌트여야 함)

## 9. AI 이어받기 시 우선 읽을 파일

긴 컨텍스트 전에 빠르게 잡아야 할 8개:

1. 이 파일 (`.claude/CLAUDE.md`)
2. `package.json` — 버전, 스크립트, dependencies
3. `src-tauri/tauri.conf.json` — 윈도우/번들/플러그인/업데이터 endpoint
4. `src/App.tsx` — 라우터 + DeepLinkBridge + AggregateSyncDriver
5. `src/lib/auth.ts` — OAuth callback 처리
6. `src/lib/supabase.ts` — supabase 클라이언트 + signInWithSlack
7. `src-tauri/src/lib.rs` — Tauri Builder + plugin 순서
8. `scripts/release.sh` — 로컬 릴리즈 파이프라인 (빌드·서명·latest.json·업로드)

자주 참조:
- `src/pages/Dashboard.tsx` — 가장 큰 페이지. granularity / period / metric / view 의 4축 제어.
- `src/hooks/useDashboardUsage.ts` — Dashboard의 통합/Claude/Codex source 라우팅.
- `src-tauri/src/summary.rs` — 로컬 SQLite summary를 source별로 동일 조건 집계.
- `src-tauri/src/codex_limits.rs` — Codex rollout에서 계정·모델별 최신 rate limit 추출.
- `src/components/ui/Select.tsx` — 디자인시스템 dropdown (외부 클릭 닫힘 + Esc + 화살표 회전).
- `src-tauri/src/db.rs` — `range_bounds(range)` 가 시간 경계 계산. 새 range 옵션은 여기에 등록.

## 10. 코드 변경 시 빠른 점검

- [ ] `pnpm build` (frontend) 통과
- [ ] 새 RPC / DB 변경이면 `supabase/migrations/*.sql` 작성 + Studio 적용
- [ ] 새 Tauri command 면 `lib.rs` 의 `invoke_handler!` 에 추가
- [ ] 새 plugin 권한이면 `capabilities/default.json` 의 `permissions` 에 추가
- [ ] 버전 bump 시 `package.json` + `src-tauri/tauri.conf.json` 둘 다 (스크립트가 불일치 시 중단)
- [ ] `.env` 변수 새로 추가 시 로컬 `.env` 갱신 (CI 없음 — `scripts/release.sh` 는 로컬 `.env` 를 그대로 사용)

## 11. 자주 쓰는 명령

```bash
# 자기 사용량 즉시 sync (개발 중 데이터 빠르게 보고 싶을 때)
# 앱 안에서 Settings 페이지의 "지금 동기화" 버튼

# 로컬 릴리즈 (서명 키 export 후) — 빌드·서명·latest.json·Draft 업로드까지
bash scripts/release.sh

# Draft release publish
gh release edit v0.1.x --draft=false

# Draft + tag 동시 정리
for v in v0.1.10 v0.1.11; do gh release delete "$v" --yes --cleanup-tag --repo madup-dct/madup-token-monitor; done
git tag -d v0.1.10 v0.1.11

# secret 안전 등록
printf '%s' "$VAL" | gh secret set NAME --repo madup-dct/madup-token-monitor
```

## 12. 미완료 / 차후 항목

- 다크 모드 토글 (Settings)
- 헤더 드래그 (현재 비활성화. 사용자가 다시 원하면 webkit-app-region 또는 NSWindow native fix)
- DailyBarChart 도 granularity 따라 그룹핑된 막대 표시 (현재는 list 만 적용)
- Apple Developer ID 서명 / notarization 도입 시 Gatekeeper 안내 제거
- Windows 지원 — v0.3.0 에서 빌드/릴리즈 파이프라인 추가 (NSIS + CI matrix). 로그인(딥링크 OAuth 콜백)은 실기기 미검증으로 SOFT/BETA. 동료 실기기 검증 완료 후 BETA 해제.
