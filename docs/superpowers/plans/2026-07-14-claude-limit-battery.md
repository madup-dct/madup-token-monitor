# Claude 한도 배터리 표시 (5h/7d/Fable) + 계정 한도 공유 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude 5h/7d/Fable 한도를 잔여 %(배터리)·3단계 색·리셋 시각으로 대시보드 패널/트레이에 표시하고, 계정 단위 한도를 Supabase 로 공유해 사이드바 "계정 한도" 페이지에서 팀 전체가 열람.

**Architecture:** Rust(oauth_usage)가 Anthropic OAuth usage API 의 새 `limits` 배열을 `windows: Vec<LimitWindow>` 로 일반화 → ① React 패널이 잔여 배터리로 렌더, ② 트레이는 상태 스트립을 RGBA 이미지로 직접 그려 `set_icon()` 교체, ③ 30초 폴링 스레드가 계정(`~/.claude.json` oauthAccount) 단위 스냅샷을 Supabase RPC 로 upsert, 새 페이지가 RPC 로 열람.

**Tech Stack:** Tauri 2 / Rust (ureq, fontdue 신규, chrono), React 19 + TS + vitest, Supabase (Postgres + security definer RPC).

**Spec:** `docs/superpowers/specs/2026-07-13-claude-limit-battery-design.md`

## Global Constraints

- 색 임계값(모든 표면 공통): **잔여 ≥70% lime / ≥30% amber / <30% coral**. 이모지 사용 금지.
- 리셋 시각 표기: 절대 시각 `MM/DD HH:mm` (로컬 tz = KST), hover 는 상대 시간.
- 커밋: 태스크별 **로컬 커밋만**, `git push` 절대 금지 (CI 없음 + 로컬 빌드 전용 룰). 메시지는 conventional + 한국어, footer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Supabase 마이그레이션 적용/검증은 **supabase-cli-agent 위임** (직접 psql 금지).
- 공유 컴포넌트 재사용 (CLAUDE.md §8): `QuotaSegBar`/`Segmented` 재사용, 신규 `StatusDot` 은 §8 표에 등록. native `<select>` 금지.
- 새 RPC 에 날짜 버킷 경계 없음 → `kst_today()` 불필요 (timestamptz 비교만).
- 버전 bump/릴리즈는 이 플랜 범위 밖 (사용자가 별도 결정).
- 명령 실행 위치: 프론트는 repo 루트(`pnpm test`, `pnpm build`), Rust 는 `src-tauri/`(`cargo test`).

---

### Task 1: Rust — oauth_usage `limits` 배열 파싱 일반화

**Files:**
- Modify: `src-tauri/src/oauth_usage.rs`

**Interfaces:**
- Produces (이후 태스크 전부가 사용):
  - `pub struct LimitWindow { pub kind: String, pub scope_model: Option<String>, pub utilization: f64, pub resets_at: String }`
  - `pub struct OAuthUsage { pub windows: Vec<LimitWindow>, pub fetched_at: String, pub is_stale: bool }`
  - `pub fn cached_usage() -> Option<OAuthUsage>` — 캐시 읽기 전용 (네트워크 없음, 트레이용)
  - `pub fn get_usage_blocking() -> Result<OAuthUsage, String>` — 10분 캐시 경유 fetch (폴링 스레드용)
- 기존 `get_oauth_usage` / `refresh_oauth_usage` command 시그니처 불변 (반환 shape 만 변경).

- [ ] **Step 1: 실패하는 테스트 작성** — `oauth_usage.rs` 파일 끝에 추가:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    // 실제 응답 축약 fixture (2026-07-13 확인) — limits 배열 + null 이 된 legacy 필드.
    const FIXTURE: &str = r#"{
        "five_hour": {"utilization": 59.0, "resets_at": "2026-07-13T13:50:00+00:00"},
        "seven_day": {"utilization": 17.0, "resets_at": "2026-07-20T08:00:00+00:00"},
        "seven_day_sonnet": null,
        "seven_day_opus": null,
        "limits": [
            {"kind": "session", "group": "session", "percent": 59, "severity": "normal",
             "resets_at": "2026-07-13T13:50:00+00:00", "scope": null, "is_active": true},
            {"kind": "weekly_all", "group": "weekly", "percent": 17, "severity": "normal",
             "resets_at": "2026-07-20T08:00:00+00:00", "scope": null, "is_active": false},
            {"kind": "weekly_scoped", "group": "weekly", "percent": 127, "severity": "normal",
             "resets_at": "2026-07-20T08:00:00+00:00",
             "scope": {"model": {"id": null, "display_name": "Fable"}, "surface": null},
             "is_active": false}
        ]
    }"#;

    #[test]
    fn parses_limits_array_including_fable_scope() {
        let api: ApiResponse = serde_json::from_str(FIXTURE).unwrap();
        let windows = windows_from_api(&api);
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].kind, "session");
        assert_eq!(windows[0].utilization, 59.0);
        assert_eq!(windows[1].kind, "weekly_all");
        assert_eq!(windows[2].kind, "weekly_scoped");
        assert_eq!(windows[2].scope_model.as_deref(), Some("Fable"));
        // percent 127 → 100 클램프
        assert_eq!(windows[2].utilization, 100.0);
    }

    #[test]
    fn skips_incomplete_limit_items() {
        let api: ApiResponse = serde_json::from_str(
            r#"{"limits":[
                {"kind":"session","percent":null,"resets_at":"2026-07-13T13:50:00+00:00"},
                {"kind":null,"percent":10,"resets_at":"2026-07-13T13:50:00+00:00"},
                {"kind":"weekly_all","percent":10,"resets_at":null},
                {"kind":"weekly_all","percent":10,"resets_at":"2026-07-20T08:00:00+00:00"}
            ]}"#,
        )
        .unwrap();
        let windows = windows_from_api(&api);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].kind, "weekly_all");
    }

    #[test]
    fn falls_back_to_legacy_fields_when_limits_missing() {
        // limits 키 자체가 없는 구버전 응답 — serde(default) 로 빈 Vec.
        let api: ApiResponse = serde_json::from_str(
            r#"{
                "five_hour": {"utilization": 42.5, "resets_at": "2026-07-13T13:50:00+00:00"},
                "seven_day": {"utilization": 18.0, "resets_at": "2026-07-20T08:00:00+00:00"},
                "seven_day_sonnet": null,
                "seven_day_opus": {"utilization": 3.0, "resets_at": "2026-07-20T08:00:00+00:00"}
            }"#,
        )
        .unwrap();
        let windows = windows_from_api(&api);
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].kind, "session");
        assert_eq!(windows[1].kind, "weekly_all");
        assert_eq!(windows[2].kind, "weekly_scoped");
        assert_eq!(windows[2].scope_model.as_deref(), Some("Opus"));
    }

    #[test]
    fn empty_response_yields_no_windows() {
        let api: ApiResponse = serde_json::from_str("{}").unwrap();
        assert!(windows_from_api(&api).is_empty());
    }
}
```

- [ ] **Step 2: 실패 확인**

Run: `cd src-tauri && cargo test oauth_usage 2>&1 | tail -20`
Expected: 컴파일 에러 — `windows_from_api` 미정의, `ApiResponse` 에 `limits` 필드 없음.

- [ ] **Step 3: 구현** — `oauth_usage.rs` 상단의 타입/파싱 교체:

기존 `UsageWindow` / `OAuthUsage` (12–26행) 를 다음으로 교체:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LimitWindow {
    pub kind: String,               // "session" | "weekly_all" | "weekly_scoped" | (미래 확장)
    pub scope_model: Option<String>, // weekly_scoped 일 때 모델 표시명 (예: "Fable")
    pub utilization: f64,           // 사용률 % (0~100 클램프)
    pub resets_at: String,          // RFC3339
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthUsage {
    pub windows: Vec<LimitWindow>,
    pub fetched_at: String,
    pub is_stale: bool,
}
```

기존 `ApiResponse` / `ApiUsageWindow` / `impl ApiUsageWindow`(36–58행) 를 다음으로 교체:

```rust
// API 가 필드를 null/부분 채움으로 반환하는 케이스가 있어 전부 Option.
// 2026-07 응답 구조 변경: 모델 scoped 주간 한도는 `limits` 배열로만 내려온다
// (seven_day_opus/sonnet 은 null). limits 우선, 없으면 legacy 필드 fallback.
#[derive(Debug, Deserialize)]
struct ApiResponse {
    five_hour: Option<ApiUsageWindow>,
    seven_day: Option<ApiUsageWindow>,
    seven_day_sonnet: Option<ApiUsageWindow>,
    seven_day_opus: Option<ApiUsageWindow>,
    #[serde(default)]
    limits: Vec<ApiLimit>,
}

#[derive(Debug, Deserialize)]
struct ApiUsageWindow {
    utilization: Option<f64>,
    resets_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiLimit {
    kind: Option<String>,
    percent: Option<f64>,
    resets_at: Option<String>,
    scope: Option<ApiLimitScope>,
}

#[derive(Debug, Deserialize)]
struct ApiLimitScope {
    model: Option<ApiScopeModel>,
}

#[derive(Debug, Deserialize)]
struct ApiScopeModel {
    display_name: Option<String>,
}

fn windows_from_api(api: &ApiResponse) -> Vec<LimitWindow> {
    let from_limits: Vec<LimitWindow> = api
        .limits
        .iter()
        .filter_map(|l| {
            Some(LimitWindow {
                kind: l.kind.clone()?,
                scope_model: l
                    .scope
                    .as_ref()
                    .and_then(|s| s.model.as_ref())
                    .and_then(|m| m.display_name.clone()),
                utilization: l.percent?.clamp(0.0, 100.0),
                resets_at: l.resets_at.clone()?,
            })
        })
        .collect();
    if !from_limits.is_empty() {
        return from_limits;
    }
    // legacy fallback — limits 배열이 없던 구버전 응답 (API 롤백 대비)
    let legacy: [(&str, Option<&str>, &Option<ApiUsageWindow>); 4] = [
        ("session", None, &api.five_hour),
        ("weekly_all", None, &api.seven_day),
        ("weekly_scoped", Some("Sonnet"), &api.seven_day_sonnet),
        ("weekly_scoped", Some("Opus"), &api.seven_day_opus),
    ];
    legacy
        .into_iter()
        .filter_map(|(kind, model, w)| {
            let w = w.as_ref()?;
            Some(LimitWindow {
                kind: kind.to_string(),
                scope_model: model.map(|m| m.to_string()),
                utilization: w.utilization?.clamp(0.0, 100.0),
                resets_at: w.resets_at.clone()?,
            })
        })
        .collect()
}
```

`fetch_usage_from_api` 의 `Ok(r)` 분기(131–139행) 를 교체:

```rust
        Ok(r) => {
            let api: ApiResponse = r.into_json().map_err(|e| format!("JSON parse: {e}"))?;
            Ok(OAuthUsage {
                windows: windows_from_api(&api),
                fetched_at: chrono::Local::now().to_rfc3339(),
                is_stale: false,
            })
        }
```

파일 끝(commands 위)에 pub 접근자 추가:

```rust
/// 캐시된 사용량 읽기 — 네트워크 호출 없음. 트레이 즉시 경로(refresh_tray_title)용.
pub fn cached_usage() -> Option<OAuthUsage> {
    OAUTH_CACHE.lock().ok()?.as_ref().map(|e| e.usage.clone())
}

/// 10분 캐시 경유 fetch (만료 시에만 네트워크). blocking — 폴링 스레드 전용.
pub fn get_usage_blocking() -> Result<OAuthUsage, String> {
    get_oauth_usage_impl(false)
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd src-tauri && cargo test oauth_usage 2>&1 | tail -5`
Expected: `test result: ok. 4 passed`

Run: `cd src-tauri && cargo test 2>&1 | tail -3` (기존 테스트 무회귀)
Expected: 전체 PASS. (참고: 프론트 `pnpm build` 는 계속 통과하지만, 런타임에 command 반환
shape 가 프론트 구 타입과 일시 불일치 — Task 4 에서 해소. 중간 상태로 정상.)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/oauth_usage.rs
git commit -m "feat: OAuth usage limits 배열 파싱 일반화 (Fable 주간 한도 지원)"
```

---

### Task 2: Rust — Claude 계정 식별자 리더

**Files:**
- Modify: `src-tauri/src/oauth_usage.rs`

**Interfaces:**
- Produces: `pub struct ClaudeAccount { pub uuid: String, pub email: String }`, `pub fn read_claude_account() -> Option<ClaudeAccount>` (Task 8 이 사용)

- [ ] **Step 1: 실패하는 테스트 작성** — Task 1 의 `mod tests` 안에 추가:

```rust
    #[test]
    fn parses_claude_account_from_config_json() {
        let json = r#"{"oauthAccount": {"accountUuid": "11111111-2222-3333-4444-555555555555",
            "emailAddress": "someone@madup.com", "organizationName": "madup"}}"#;
        let acc = parse_claude_account(json).unwrap();
        assert_eq!(acc.uuid, "11111111-2222-3333-4444-555555555555");
        assert_eq!(acc.email, "someone@madup.com");
    }

    #[test]
    fn claude_account_none_when_missing() {
        assert!(parse_claude_account("{}").is_none());
        assert!(parse_claude_account("not json").is_none());
        assert!(parse_claude_account(r#"{"oauthAccount": {"accountUuid": "x"}}"#).is_none());
    }
```

- [ ] **Step 2: 실패 확인**

Run: `cd src-tauri && cargo test oauth_usage 2>&1 | tail -5`
Expected: 컴파일 에러 — `parse_claude_account` 미정의.

- [ ] **Step 3: 구현** — `read_oauth_token_file` 함수 아래에 추가:

```rust
/// 이 기기에 로그인된 Claude 계정 식별자.
/// 한도의 주체는 앱 유저가 아니라 Claude 계정 — 팀이 계정을 나눠 쓰고 기기의 로그인
/// 계정도 수시로 바뀌므로, Supabase 스냅샷은 이 값을 키로 upsert 한다.
#[derive(Debug, Clone)]
pub struct ClaudeAccount {
    pub uuid: String,
    pub email: String,
}

fn parse_claude_account(json: &str) -> Option<ClaudeAccount> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let oa = v.get("oauthAccount")?;
    Some(ClaudeAccount {
        uuid: oa.get("accountUuid")?.as_str()?.to_string(),
        email: oa.get("emailAddress")?.as_str()?.to_string(),
    })
}

/// `$CLAUDE_CONFIG_DIR/.claude.json` 우선, 없으면 `~/.claude.json`.
pub fn read_claude_account() -> Option<ClaudeAccount> {
    let dir: PathBuf = std::env::var("CLAUDE_CONFIG_DIR")
        .ok()
        .map(PathBuf::from)
        .or_else(dirs::home_dir)?;
    let content = std::fs::read_to_string(dir.join(".claude.json")).ok()?;
    parse_claude_account(&content)
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd src-tauri && cargo test oauth_usage 2>&1 | tail -5`
Expected: `test result: ok. 6 passed`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/oauth_usage.rs
git commit -m "feat: 로컬 Claude 계정 식별자 리더 추가 (~/.claude.json oauthAccount)"
```

---

### Task 3: Frontend — 잔여 기준 색상 전환 + 한도 표시 헬퍼 (`src/lib/limits.ts`)

**Files:**
- Modify: `src/components/ui/quotaSignal.ts`
- Modify: `src/types/models.ts` (LimitWindow 타입 추가)
- Create: `src/lib/limits.ts`
- Test: `src/lib/limits.test.ts`

**Interfaces:**
- Produces:
  - `pickQuotaSignal(remaining: number)` — **의미 반전**: 입력이 "잔여 비율 0..1". ≥0.7 lime / ≥0.3 amber / <0.3 coral. `quotaSignalClass(remaining)` 동일.
  - `models.ts`: `export interface LimitWindow { kind: string; scope_model: string | null; utilization: number; resets_at: string }`
  - `lib/limits.ts`: `remainingPct(utilization): number`(0~100 정수), `windowLabel(w): string`, `windowShortLabel(w): string`, `formatResetKo(ms): string`("07/14 00:59"), `formatRelativeTimeKo(ms): string`("2시간 30분"), `minRemaining(windows): number | null`, `type SortKind = "session" | "weekly_all" | "weekly_scoped"`, `windowOfKind(windows, kind)`, `sortByRemainingDesc(rows, windowsOf, kind)`
- Consumes: 없음 (순수 함수만)

- [ ] **Step 1: 실패하는 테스트 작성** — `src/lib/limits.test.ts` 생성:

```ts
import { describe, expect, it } from "vitest";
import { pickQuotaSignal } from "@/components/ui/quotaSignal";
import {
  formatResetKo,
  minRemaining,
  remainingPct,
  sortByRemainingDesc,
  windowLabel,
  windowOfKind,
  windowShortLabel,
} from "@/lib/limits";
import type { LimitWindow } from "@/types/models";

function w(kind: string, utilization: number, scope_model: string | null = null): LimitWindow {
  return { kind, scope_model, utilization, resets_at: "2026-07-20T08:00:00+00:00" };
}

describe("pickQuotaSignal (잔여 기준)", () => {
  it("잔여 ≥70% 초록 / ≥30% 노랑 / <30% 빨강", () => {
    expect(pickQuotaSignal(0.92)).toBe("lime");
    expect(pickQuotaSignal(0.7)).toBe("lime");
    expect(pickQuotaSignal(0.69)).toBe("amber");
    expect(pickQuotaSignal(0.3)).toBe("amber");
    expect(pickQuotaSignal(0.29)).toBe("coral");
    expect(pickQuotaSignal(0)).toBe("coral");
  });
});

describe("remainingPct", () => {
  it("100 - 사용률, 0~100 클램프, 정수 반올림", () => {
    expect(remainingPct(59)).toBe(41);
    expect(remainingPct(42.5)).toBe(58);
    expect(remainingPct(0)).toBe(100);
    expect(remainingPct(120)).toBe(0);
    expect(remainingPct(-5)).toBe(100);
  });
});

describe("windowLabel / windowShortLabel", () => {
  it("kind 별 한국어 라벨", () => {
    expect(windowLabel(w("session", 0))).toBe("5시간 한도");
    expect(windowLabel(w("weekly_all", 0))).toBe("주간 한도");
    expect(windowLabel(w("weekly_scoped", 0, "Fable"))).toBe("주간 · Fable");
    expect(windowLabel(w("unknown_kind", 0))).toBe("unknown_kind");
  });
  it("트레이/페이지용 축약 라벨", () => {
    expect(windowShortLabel(w("session", 0))).toBe("5h");
    expect(windowShortLabel(w("weekly_all", 0))).toBe("7d");
    expect(windowShortLabel(w("weekly_scoped", 0, "Fable"))).toBe("F");
  });
});

describe("formatResetKo", () => {
  it("MM/DD HH:mm (로컬 tz)", () => {
    const ms = new Date(2026, 6, 14, 0, 59).getTime(); // 로컬 07/14 00:59
    expect(formatResetKo(ms)).toBe("07/14 00:59");
  });
});

describe("minRemaining / windowOfKind / sortByRemainingDesc", () => {
  const rows = [
    { name: "a", windows: [w("session", 8), w("weekly_scoped", 48, "Fable")] },
    { name: "b", windows: [w("session", 50), w("weekly_scoped", 10, "Fable")] },
    { name: "c", windows: [w("session", 20)] }, // Fable 창 없음 → 뒤로
  ];
  it("최저 잔여", () => {
    expect(minRemaining(rows[0].windows)).toBe(52);
    expect(minRemaining([])).toBeNull();
  });
  it("kind 로 창 찾기", () => {
    expect(windowOfKind(rows[0].windows, "weekly_scoped")?.scope_model).toBe("Fable");
    expect(windowOfKind(rows[2].windows, "weekly_scoped")).toBeNull();
  });
  it("잔여 많은 순 정렬, 창 없는 row 는 마지막", () => {
    const sorted = sortByRemainingDesc(rows, (r) => r.windows, "weekly_scoped");
    expect(sorted.map((r) => r.name)).toEqual(["b", "a", "c"]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm test 2>&1 | tail -15`
Expected: FAIL — `@/lib/limits` 모듈 없음, `LimitWindow` export 없음, pickQuotaSignal 임계값 불일치.

- [ ] **Step 3: 구현**

`src/components/ui/quotaSignal.ts` 전체 교체:

```ts
export type QuotaSignal = "lime" | "amber" | "coral";

/// 입력은 "잔여 비율" 0..1 (배터리 의미). 잔여 ≥70% 여유 / ≥30% 주의 / <30% 위험.
export function pickQuotaSignal(remaining: number): QuotaSignal {
  if (remaining >= 0.7) return "lime";
  if (remaining >= 0.3) return "amber";
  return "coral";
}

export function quotaSignalClass(remaining: number): string {
  const signal = pickQuotaSignal(Math.max(0, Math.min(1, remaining)));
  return signal === "lime" ? "text-lime" : signal === "amber" ? "text-amber" : "text-coral";
}
```

`src/types/models.ts` 에 추가 (CodexRateLimitSnapshot 근처):

```ts
/// Anthropic OAuth usage API 의 한도 창 1개 — Rust LimitWindow 와 동일 shape.
export interface LimitWindow {
  kind: string; // "session" | "weekly_all" | "weekly_scoped" | (미래 확장)
  scope_model: string | null;
  utilization: number; // 사용률 % 0~100
  resets_at: string; // RFC3339
}
```

`src/lib/limits.ts` 생성:

```ts
// Claude 한도 표시 공통 로직 — 잔여 %(배터리) 변환, 라벨, 리셋 포맷, 정렬.
// UsageLimitPanel(대시보드) 과 AccountLimits(계정 한도 페이지) 가 공유한다.
import type { LimitWindow } from "@/types/models";

export function remainingPct(utilization: number): number {
  return Math.round(Math.min(100, Math.max(0, 100 - utilization)));
}

export function windowLabel(w: LimitWindow): string {
  if (w.kind === "session") return "5시간 한도";
  if (w.kind === "weekly_all") return "주간 한도";
  if (w.kind === "weekly_scoped") return `주간 · ${w.scope_model ?? "모델"}`;
  return w.kind;
}

export function windowShortLabel(w: LimitWindow): string {
  if (w.kind === "session") return "5h";
  if (w.kind === "weekly_all") return "7d";
  const base = w.scope_model ?? w.kind;
  return base.slice(0, 1).toUpperCase();
}

/// "07/14 00:59" — 로컬 tz(KST). 리셋 절대 시각 표기.
export function formatResetKo(ms: number): string {
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi}`;
}

/// "3일 2시간" / "2시간 30분" / "5분" — hover 보조 표기.
export function formatRelativeTimeKo(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}일 ${hours}시간` : `${days}일`;
  if (hours > 0) return minutes > 0 ? `${hours}시간 ${minutes}분` : `${hours}시간`;
  return `${minutes}분`;
}

export function minRemaining(windows: readonly LimitWindow[]): number | null {
  if (windows.length === 0) return null;
  return Math.min(...windows.map((w) => remainingPct(w.utilization)));
}

export type SortKind = "session" | "weekly_all" | "weekly_scoped";

export function windowOfKind(
  windows: readonly LimitWindow[],
  kind: SortKind,
): LimitWindow | null {
  return windows.find((w) => w.kind === kind) ?? null;
}

/// 잔여 많은 순 정렬 — "쉐어 요청할 계정" 이 위로. 해당 창이 없는 row 는 마지막.
export function sortByRemainingDesc<T>(
  rows: readonly T[],
  windowsOf: (row: T) => readonly LimitWindow[],
  kind: SortKind,
): T[] {
  return [...rows].sort((a, b) => {
    const wa = windowOfKind(windowsOf(a), kind);
    const wb = windowOfKind(windowsOf(b), kind);
    const va = wa ? remainingPct(wa.utilization) : -1;
    const vb = wb ? remainingPct(wb.utilization) : -1;
    return vb - va;
  });
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm test 2>&1 | tail -8`
Expected: limits.test.ts 전체 PASS + 기존 테스트 무회귀. `pnpm build` 도 통과.
(참고: 이 시점엔 기존 패널이 사용률을 잔여 기준 색 함수에 넘겨 색 의미가 일시적으로
반대 — Task 4 에서 패널을 잔여 입력으로 전환하며 해소. 중간 상태로 정상.)

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/quotaSignal.ts src/types/models.ts src/lib/limits.ts src/lib/limits.test.ts
git commit -m "feat: 한도 색상을 잔여(배터리) 기준으로 전환 + 한도 표시 헬퍼 추가"
```

---

### Task 4: Frontend — 패널 배터리 전환 (StatusDot + UsageLimitPanel + 타입/mock)

**Files:**
- Create: `src/components/ui/StatusDot.tsx`
- Modify: `src/hooks/useRateLimits.ts`
- Modify: `src/components/dashboard/UsageLimitPanel.tsx`

**Interfaces:**
- Consumes: Task 3 의 `lib/limits.ts` 헬퍼, `models.ts` `LimitWindow`, 잔여 기준 `quotaSignalClass`
- Produces:
  - `StatusDot({ remaining: number | null, size?: number })` — remaining 0..1, null=회색 (Task 9 재사용)
  - `useRateLimits.ts` 의 `OAuthUsage` = `{ windows: LimitWindow[]; fetched_at: string; is_stale: boolean }` (Rust Task 1 과 동일 shape)
  - `ClaudeLimits` / `CodexLimits` props 시그니처 불변 (Dashboard 수정 불필요)

- [ ] **Step 1: StatusDot 생성** — `src/components/ui/StatusDot.tsx`:

```tsx
import { pickQuotaSignal, type QuotaSignal } from "@/components/ui/quotaSignal";

const DOT_BG: Record<QuotaSignal, string> = {
  lime: "var(--color-lime)",
  amber: "var(--color-amber)",
  coral: "var(--color-coral)",
};

/// 3단계 잔여 상태 점 — 한도 패널·계정 한도 페이지 공용 (이모지 대체).
/// remaining: 잔여 비율 0..1, null 이면 갱신 대기(회색).
export function StatusDot({
  remaining,
  size = 8,
}: {
  readonly remaining: number | null;
  readonly size?: number;
}) {
  const background =
    remaining === null ? "var(--color-surface-3)" : DOT_BG[pickQuotaSignal(remaining)];
  return (
    <span
      aria-hidden="true"
      className="inline-block rounded-full shrink-0"
      style={{ width: size, height: size, background }}
    />
  );
}
```

- [ ] **Step 2: useRateLimits 타입/mock 갱신** — `src/hooks/useRateLimits.ts` 의 `OAuthUsageWindow`/`OAuthUsage` 인터페이스(7–19행) 와 `buildMockOAuthUsage`(35–51행) 를 교체:

```ts
import type { CodexRateLimitSnapshot, LimitWindow } from "@/types/models";

export interface OAuthUsage {
  windows: LimitWindow[];
  fetched_at: string;
  is_stale: boolean;
}
```

```ts
function buildMockOAuthUsage(): OAuthUsage {
  const now = Date.now();
  // 잔여 92 / 58 / 22 — 3단계 색(초록/노랑/빨강)을 dev 에서 모두 확인.
  return {
    windows: [
      {
        kind: "session",
        scope_model: null,
        utilization: 8,
        resets_at: new Date(now + 2 * 3_600_000).toISOString(),
      },
      {
        kind: "weekly_all",
        scope_model: null,
        utilization: 42.5,
        resets_at: new Date(now + 5 * 86_400_000).toISOString(),
      },
      {
        kind: "weekly_scoped",
        scope_model: "Fable",
        utilization: 78,
        resets_at: new Date(now + 5 * 86_400_000).toISOString(),
      },
    ],
    fetched_at: new Date(now).toISOString(),
    is_stale: false,
  };
}
```

기존 `OAuthUsageWindow` export 는 삭제 (사용처는 UsageLimitPanel 뿐 — Step 3 에서 함께 제거).

- [ ] **Step 3: UsageLimitPanel 배터리 전환** — `src/components/dashboard/UsageLimitPanel.tsx` 에서 `ClaudeLimits`(6–41행), `CodexLimits`(43–81행), `formatRelativeTimeKo`(94–102행, lib 로 이동했으므로 삭제), `LimitRow`(104–132행) 를 교체. `limitLabel`/`LimitEmpty` 는 그대로 유지:

```tsx
import { QuotaSegBar } from "@/components/ui/QuotaSegBar";
import { StatusDot } from "@/components/ui/StatusDot";
import { quotaSignalClass } from "@/components/ui/quotaSignal";
import {
  formatRelativeTimeKo,
  formatResetKo,
  remainingPct,
  windowLabel,
} from "@/lib/limits";
import type { OAuthUsage } from "@/hooks/useRateLimits";
import type { CodexRateLimitSnapshot, CodexRateLimitWindow } from "@/types/models";

export function ClaudeLimits({
  usage,
  error,
  nowMs,
}: {
  readonly usage: OAuthUsage | null;
  readonly error: string | null;
  readonly nowMs: number;
}) {
  const windows = usage?.windows ?? [];
  if (windows.length === 0) {
    return <LimitEmpty title="Claude OAuth 한도 정보 없음" detail={error} />;
  }
  return (
    <div className="h-full pr-1">
      {windows.map((w, i) => {
        const resetMs = new Date(w.resets_at).getTime();
        const fresh = !usage?.is_stale && Number.isFinite(resetMs) && resetMs > nowMs;
        return (
          <LimitRow
            key={`${w.kind}:${w.scope_model ?? i}`}
            label={windowLabel(w)}
            remainingPercent={fresh ? remainingPct(w.utilization) : null}
            resetMs={fresh ? resetMs : null}
            nowMs={nowMs}
          />
        );
      })}
    </div>
  );
}

export function CodexLimits({
  snapshots,
  nowMs,
}: {
  readonly snapshots: readonly CodexRateLimitSnapshot[];
  readonly nowMs: number;
}) {
  const rows = snapshots.flatMap((snapshot) =>
    [snapshot.primary, snapshot.secondary].flatMap((window, index) =>
      window
        ? [{ key: `${snapshot.limit_id}:${index}`, label: limitLabel(snapshot, window), window }]
        : []
    )
  );
  if (rows.length === 0) {
    return (
      <LimitEmpty title="Codex 한도 기록 없음" detail="Codex에서 요청을 실행하면 갱신됩니다." />
    );
  }
  return (
    <div className="h-full pr-1">
      {rows.map((row) => {
        const resetMs = row.window.resets_at * 1000;
        const fresh = resetMs > nowMs;
        return (
          <LimitRow
            key={row.key}
            label={row.label}
            remainingPercent={fresh ? remainingPct(row.window.used_percent) : null}
            resetMs={fresh ? resetMs : null}
            nowMs={nowMs}
          />
        );
      })}
    </div>
  );
}

function LimitRow({
  label,
  remainingPercent,
  resetMs,
  nowMs,
}: {
  readonly label: string;
  readonly remainingPercent: number | null; // null = 갱신 대기
  readonly resetMs: number | null;
  readonly nowMs: number;
}) {
  const value =
    remainingPercent === null ? null : Math.min(1, Math.max(0, remainingPercent / 100));
  const resetLabel = resetMs === null ? "갱신 대기" : `리셋 ${formatResetKo(resetMs)}`;
  const resetTitle =
    resetMs === null ? undefined : `${formatRelativeTimeKo(resetMs - nowMs)} 후 초기화`;
  return (
    <div className="mt-4 first:mt-1">
      <div className="flex items-center justify-between mb-2 gap-3">
        <span className="flex items-center gap-2 min-w-0">
          <StatusDot remaining={value} />
          <span className="text-[12px] font-semibold text-text-primary truncate" title={label}>
            {label}
          </span>
        </span>
        <span
          className="flex items-center gap-2.5 text-[10.5px] text-text-secondary whitespace-nowrap shrink-0"
          title={resetTitle}
        >
          {resetLabel}
          <strong
            className={`num text-[13px] font-medium ${value === null ? "text-text-faint" : quotaSignalClass(value)}`}
          >
            {remainingPercent === null ? "—" : `잔여 ${remainingPercent}%`}
          </strong>
        </span>
      </div>
      <QuotaSegBar value={value} label={`${label} 잔여`} />
    </div>
  );
}
```

- [ ] **Step 4: 빌드/테스트 확인**

Run: `pnpm test 2>&1 | tail -5` → PASS
Run: `pnpm build 2>&1 | tail -5` → 성공 (tsc 에러 0)

- [ ] **Step 5: mock 육안 확인 (선택, 권장)**

Run: `pnpm dev` → 브라우저 `http://localhost:1420` → Dashboard 캐러셀 "Claude 한도" 면.
Expected: 5시간(초록 점, 잔여 92%) / 주간(노랑, 58%) / 주간·Fable(빨강, 22%) 3행, 세그바가 잔여만큼 채워짐, "리셋 07/XX HH:mm" 표기, hover 시 "N시간 후 초기화".

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/StatusDot.tsx src/hooks/useRateLimits.ts src/components/dashboard/UsageLimitPanel.tsx
git commit -m "feat: 한도 패널 잔여 배터리 전환 (Fable 표시 + 상태점 + 절대 리셋 시각)"
```

---

### Task 5: 설정 토글 `show_menubar_limits` (Rust + Settings)

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src/pages/Settings.tsx`

**Interfaces:**
- Produces: `pub fn read_show_menubar_limits() -> bool` (기본 **false**; Task 6 이 사용). 설정 키 문자열 `"show_menubar_limits"`.
- Consumes: 기존 `read_settings`/`write_settings`/`set_setting` 인프라.

- [ ] **Step 1: Rust 설정 리더 추가** — `commands.rs` 의 `read_show_menubar_cost`(108–116행) 바로 아래:

```rust
/// 트레이 한도(잔여 배터리) 표시 여부. 기본값 false (opt-in).
pub fn read_show_menubar_limits() -> bool {
    matches!(
        read_settings().get("show_menubar_limits"),
        Some(JsonValue::Bool(true))
    )
}
```

`set_setting`(124행 부근) 의 트레이 갱신 조건 변경:

```rust
    let touched_menubar = key == "show_menubar_cost" || key == "show_menubar_limits";
```

- [ ] **Step 2: Rust 컴파일 확인**

Run: `cd src-tauri && cargo build 2>&1 | tail -3`
Expected: 성공 (dead_code 경고 가능 — Task 6 에서 사용되면 소멸).

- [ ] **Step 3: Settings UI 토글 추가** — `src/pages/Settings.tsx` 4곳:

(a) 캐시 키(26행 부근):

```ts
const SHOW_MENUBAR_LIMITS_KEY = "madup-token-monitor:showMenubarLimits";
```

(b) `AppSettings`(28–31행):

```ts
interface AppSettings {
  show_menubar_cost?: boolean;
  show_menubar_limits?: boolean;
  notify_on_update?: boolean;
}
```

(c) state(80행 부근, showMenubarCost 아래) + bootstrap(136행 부근 `get_settings` then 블록 안):

```ts
  const [showMenubarLimits, setShowMenubarLimits] = useState<boolean>(
    () => readJson<boolean>(SHOW_MENUBAR_LIMITS_KEY) ?? false,
  );
```

```ts
          const sml = s.show_menubar_limits ?? false;
          setShowMenubarLimits(sml);
          writeJson(SHOW_MENUBAR_LIMITS_KEY, sml);
```

(d) 핸들러(handleShowMenubarCostChange 아래) + SwitchRow(508행 부근, 기존 두 SwitchRow 사이):

```ts
  async function handleShowMenubarLimitsChange(next: boolean) {
    setShowMenubarLimits(next);
    writeJson(SHOW_MENUBAR_LIMITS_KEY, next);
    if (!IS_TAURI) return;
    invoke("set_setting", { key: "show_menubar_limits", value: next }).catch(() => {
      setShowMenubarLimits(!next);
      writeJson(SHOW_MENUBAR_LIMITS_KEY, !next);
    });
  }
```

```tsx
          <SwitchRow
            checked={showMenubarLimits}
            disabled={!IS_TAURI}
            onChange={handleShowMenubarLimitsChange}
            label="트레이/메뉴바에 Claude 잔여 한도 표시"
            description="5h/7d/Fable 잔여 %를 상태색 점과 함께 메뉴바에 표시합니다. 데이터는 Claude Code 로그인 계정 기준입니다."
          />
```

- [ ] **Step 4: 빌드 확인**

Run: `pnpm build 2>&1 | tail -3` → 성공.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src/pages/Settings.tsx
git commit -m "feat: 메뉴바 한도 표시 토글(show_menubar_limits) 추가"
```

---

### Task 6: Rust — 트레이 상태 스트립 이미지 렌더 + 트레이 통합

**Files:**
- Modify: `src-tauri/Cargo.toml` (fontdue 추가)
- Create: `src-tauri/src/tray_render.rs`
- Modify: `src-tauri/src/tray.rs`
- Modify: `src-tauri/src/lib.rs` (`pub mod tray_render;` 등록)

**Interfaces:**
- Consumes: Task 1 `cached_usage()`, Task 5 `read_show_menubar_limits()`
- Produces:
  - `tray_render::TrayItem { pub label: String, pub remaining_pct: f64 }`
  - `tray_render::render_status_strip(logo_rgba: Option<(&[u8], u32, u32)>, cost_text: Option<&str>, items: &[TrayItem], dark_menubar: bool) -> Option<(Vec<u8>, u32, u32)>` — RGBA 버퍼. 폰트 로드 실패/빈 items 면 None (호출부 텍스트 fallback).

- [ ] **Step 1: 의존성 추가** — `src-tauri/Cargo.toml` `[dependencies]` 에:

```toml
fontdue = "0.9"
```

- [ ] **Step 2: 실패하는 테스트 작성** — `src-tauri/src/tray_render.rs` 를 테스트만 담아 생성하고 `lib.rs` 의 `pub mod tray;` 아래에 `pub mod tray_render;` 추가:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    // macOS 시스템 폰트가 있는 환경에서만 의미 있는 스모크 테스트.
    #[cfg(target_os = "macos")]
    #[test]
    fn renders_strip_with_expected_height() {
        let items = vec![
            TrayItem { label: "5h".into(), remaining_pct: 92.0 },
            TrayItem { label: "7d".into(), remaining_pct: 58.0 },
            TrayItem { label: "F".into(), remaining_pct: 22.0 },
        ];
        let (buf, w, h) =
            render_status_strip(None, Some("$12"), &items, true).expect("font should load");
        assert_eq!(h, 18 * SCALE);
        assert!(w > 50 * SCALE, "strip too narrow: {w}");
        assert_eq!(buf.len(), (w * h * 4) as usize);
        // 무언가 그려졌는지 — 완전 투명이 아니어야 한다.
        assert!(buf.chunks(4).any(|p| p[3] > 0));
    }

    #[test]
    fn returns_none_for_empty_items() {
        assert!(render_status_strip(None, Some("$12"), &[], true).is_none());
    }

    #[test]
    fn dot_color_matches_thresholds() {
        assert_eq!(dot_color(92.0), GREEN);
        assert_eq!(dot_color(70.0), GREEN);
        assert_eq!(dot_color(69.9), YELLOW);
        assert_eq!(dot_color(30.0), YELLOW);
        assert_eq!(dot_color(29.9), RED);
    }
}
```

Run: `cd src-tauri && cargo test tray_render 2>&1 | tail -5`
Expected: 컴파일 에러 (본체 미구현).

- [ ] **Step 3: 렌더러 구현** — `tray_render.rs` 본체 (테스트 위에):

```rust
// 트레이 상태 스트립 렌더 — 로고 + $비용 + (상태점 + 라벨 + 잔여%) 를 RGBA 버퍼에 직접 그린다.
// macOS 트레이 타이틀은 일반 텍스트라 색을 못 입히므로 아이콘 이미지 전체를 교체하는 방식
// (스펙 §2). 폰트는 macOS 시스템 TTF 런타임 로드 — 실패 시 None, 호출부가 텍스트 타이틀로
// fallback 한다.

use fontdue::{Font, FontSettings};
use std::sync::OnceLock;

pub struct TrayItem {
    pub label: String,      // "5h" | "7d" | "F"
    pub remaining_pct: f64, // 잔여 % 0..100
}

/// Retina 스케일. 실기기에서 아이콘이 너무 크게/흐리게 보이면 1 로 조정 (스펙 §2 리스크).
pub const SCALE: u32 = 2;
const BASE_H: u32 = 18; // 메뉴바 논리 높이(pt)
const FONT_PT: f32 = 11.0;

pub const GREEN: [u8; 4] = [52, 199, 89, 255]; // systemGreen
pub const YELLOW: [u8; 4] = [255, 204, 0, 255]; // systemYellow
pub const RED: [u8; 4] = [255, 59, 48, 255]; // systemRed

pub fn dot_color(remaining_pct: f64) -> [u8; 4] {
    if remaining_pct >= 70.0 {
        GREEN
    } else if remaining_pct >= 30.0 {
        YELLOW
    } else {
        RED
    }
}

static FONT: OnceLock<Option<Font>> = OnceLock::new();

fn font() -> Option<&'static Font> {
    FONT.get_or_init(|| {
        let candidates = [
            "/System/Library/Fonts/Geneva.ttf",
            "/System/Library/Fonts/Monaco.ttf",
            "/System/Library/Fonts/Supplemental/Arial.ttf",
        ];
        for path in candidates {
            if let Ok(bytes) = std::fs::read(path) {
                if let Ok(f) = Font::from_bytes(bytes, FontSettings::default()) {
                    return Some(f);
                }
            }
        }
        None
    })
    .as_ref()
}

struct Canvas {
    buf: Vec<u8>,
    w: u32,
    h: u32,
}

impl Canvas {
    fn new(w: u32, h: u32) -> Self {
        Self { buf: vec![0; (w * h * 4) as usize], w, h }
    }

    /// 단순 over 알파 블렌딩 — 메뉴바 배경 위에 얹히므로 정밀 premultiply 불필요.
    fn blend(&mut self, x: i32, y: i32, color: [u8; 4], alpha: f32) {
        if x < 0 || y < 0 || x >= self.w as i32 || y >= self.h as i32 {
            return;
        }
        let a = (alpha.clamp(0.0, 1.0) * color[3] as f32) / 255.0;
        if a <= 0.0 {
            return;
        }
        let idx = ((y as u32 * self.w + x as u32) * 4) as usize;
        for c in 0..3 {
            let dst = self.buf[idx + c] as f32;
            self.buf[idx + c] = (color[c] as f32 * a + dst * (1.0 - a)).round() as u8;
        }
        let da = self.buf[idx + 3] as f32 / 255.0;
        self.buf[idx + 3] = ((a + da * (1.0 - a)) * 255.0).round() as u8;
    }

    fn fill_circle(&mut self, cx: f32, cy: f32, r: f32, color: [u8; 4]) {
        let (x0, x1) = ((cx - r - 1.0) as i32, (cx + r + 1.0) as i32);
        let (y0, y1) = ((cy - r - 1.0) as i32, (cy + r + 1.0) as i32);
        for y in y0..=y1 {
            for x in x0..=x1 {
                let d = (((x as f32 + 0.5) - cx).powi(2) + ((y as f32 + 0.5) - cy).powi(2)).sqrt();
                let alpha = (r - d + 0.5).clamp(0.0, 1.0); // 1px 안티앨리어스 에지
                self.blend(x, y, color, alpha);
            }
        }
    }
}

fn text_width(f: &Font, text: &str, px: f32) -> f32 {
    text.chars().map(|c| f.metrics(c, px).advance_width).sum()
}

fn draw_text(
    canvas: &mut Canvas,
    f: &Font,
    text: &str,
    x: f32,
    baseline: f32,
    px: f32,
    color: [u8; 4],
) -> f32 {
    let mut pen = x;
    for ch in text.chars() {
        let (m, bitmap) = f.rasterize(ch, px);
        let gx = (pen + m.xmin as f32) as i32;
        let gy = (baseline - (m.height as f32 + m.ymin as f32)) as i32;
        for row in 0..m.height {
            for col in 0..m.width {
                let cov = bitmap[row * m.width + col] as f32 / 255.0;
                canvas.blend(gx + col as i32, gy + row as i32, color, cov);
            }
        }
        pen += m.advance_width;
    }
    pen
}

/// 로고 RGBA 를 box-average 로 target 높이에 맞춰 축소 (비율 유지).
fn resize_rgba(src: &[u8], sw: u32, sh: u32, th: u32) -> (Vec<u8>, u32, u32) {
    let tw = ((sw as f32) * (th as f32) / (sh as f32)).round().max(1.0) as u32;
    let mut out = vec![0u8; (tw * th * 4) as usize];
    for ty in 0..th {
        for tx in 0..tw {
            let x0 = (tx as f32 / tw as f32 * sw as f32) as u32;
            let x1 = ((((tx + 1) as f32) / tw as f32 * sw as f32).ceil() as u32).min(sw);
            let y0 = (ty as f32 / th as f32 * sh as f32) as u32;
            let y1 = ((((ty + 1) as f32) / th as f32 * sh as f32).ceil() as u32).min(sh);
            let (mut r, mut g, mut b, mut a, mut n) = (0u32, 0u32, 0u32, 0u32, 0u32);
            for sy in y0..y1.max(y0 + 1) {
                for sx in x0..x1.max(x0 + 1) {
                    let i = ((sy * sw + sx) * 4) as usize;
                    r += src[i] as u32;
                    g += src[i + 1] as u32;
                    b += src[i + 2] as u32;
                    a += src[i + 3] as u32;
                    n += 1;
                }
            }
            let o = ((ty * tw + tx) * 4) as usize;
            out[o] = (r / n) as u8;
            out[o + 1] = (g / n) as u8;
            out[o + 2] = (b / n) as u8;
            out[o + 3] = (a / n) as u8;
        }
    }
    (out, tw, th)
}

/// 상태 스트립 렌더. 반환 (rgba, w, h). 폰트 로드 실패 또는 items 비면 None.
pub fn render_status_strip(
    logo_rgba: Option<(&[u8], u32, u32)>,
    cost_text: Option<&str>,
    items: &[TrayItem],
    dark_menubar: bool,
) -> Option<(Vec<u8>, u32, u32)> {
    if items.is_empty() {
        return None;
    }
    let f = font()?;
    let h = BASE_H * SCALE;
    let px = FONT_PT * SCALE as f32;
    let text_color: [u8; 4] = if dark_menubar {
        [255, 255, 255, 230]
    } else {
        [0, 0, 0, 220]
    };
    let dot_r = 3.0 * SCALE as f32;
    let gap = 5.0 * SCALE as f32;
    let sep = 9.0 * SCALE as f32;

    // 1) 폭 측정
    let logo = logo_rgba.map(|(buf, w0, h0)| resize_rgba(buf, w0, h0, h));
    let mut w = 0.0f32;
    if let Some((_, lw, _)) = &logo {
        w += *lw as f32 + gap;
    }
    if let Some(cost) = cost_text {
        w += text_width(f, cost, px) + sep;
    }
    for (i, item) in items.iter().enumerate() {
        w += dot_r * 2.0 + gap * 0.6;
        w += text_width(f, &item_text(item), px);
        if i + 1 < items.len() {
            w += sep;
        }
    }
    let w = (w.ceil() as u32).max(1);

    // 2) 드로잉
    let mut canvas = Canvas::new(w, h);
    let baseline = h as f32 * 0.72;
    let dot_cy = h as f32 * 0.52;
    let mut pen = 0.0f32;
    if let Some((buf, lw, lh)) = &logo {
        for y in 0..*lh {
            for x in 0..*lw {
                let i = ((y * lw + x) * 4) as usize;
                canvas.blend(
                    x as i32,
                    y as i32,
                    [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]],
                    1.0,
                );
            }
        }
        pen += *lw as f32 + gap;
    }
    if let Some(cost) = cost_text {
        pen = draw_text(&mut canvas, f, cost, pen, baseline, px, text_color) + sep;
    }
    for (i, item) in items.iter().enumerate() {
        canvas.fill_circle(pen + dot_r, dot_cy, dot_r, dot_color(item.remaining_pct));
        pen += dot_r * 2.0 + gap * 0.6;
        pen = draw_text(&mut canvas, f, &item_text(item), pen, baseline, px, text_color);
        if i + 1 < items.len() {
            pen += sep;
        }
    }
    Some((canvas.buf, w, h))
}

fn item_text(item: &TrayItem) -> String {
    format!("{} {}", item.label, item.remaining_pct.round() as i64)
}
```

Run: `cd src-tauri && cargo test tray_render 2>&1 | tail -5` → `3 passed`

- [ ] **Step 4: 트레이 통합** — `src-tauri/src/tray.rs`:

(a) 파일 상단 import 아래에 추가:

```rust
use std::sync::Mutex;

/// 마지막 렌더 내용 키 — 동일 내용이면 30초 폴링마다 아이콘 재설정을 생략.
/// 비어 있지 않으면 "현재 커스텀 스트립 아이콘 상태"라는 뜻 (fallback 시 로고 복원 필요).
static LAST_RENDER_KEY: Mutex<String> = Mutex::new(String::new());

#[cfg(target_os = "macos")]
fn is_dark_menubar() -> bool {
    std::process::Command::new("defaults")
        .args(["read", "-g", "AppleInterfaceStyle"])
        .output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).contains("Dark"))
        .unwrap_or(false)
}

/// OAuth 캐시의 windows → 트레이 표시 아이템. 리셋 경과 창은 생략(갱신 대기).
fn tray_items_from_usage(
    usage: &crate::oauth_usage::OAuthUsage,
    now: chrono::DateTime<chrono::Utc>,
) -> Vec<crate::tray_render::TrayItem> {
    if usage.is_stale {
        return Vec::new();
    }
    usage
        .windows
        .iter()
        .filter_map(|w| {
            let resets = chrono::DateTime::parse_from_rfc3339(&w.resets_at).ok()?;
            if resets <= now {
                return None;
            }
            let label = match w.kind.as_str() {
                "session" => "5h".to_string(),
                "weekly_all" => "7d".to_string(),
                _ => w
                    .scope_model
                    .as_deref()
                    .unwrap_or(w.kind.as_str())
                    .chars()
                    .next()
                    .map(|c| c.to_ascii_uppercase().to_string())?,
            };
            Some(crate::tray_render::TrayItem {
                label,
                remaining_pct: (100.0 - w.utilization).clamp(0.0, 100.0),
            })
        })
        .collect()
}
```

(b) `refresh_tray_title` 전체 교체:

```rust
pub fn refresh_tray_title<R: Runtime>(app: &AppHandle<R>) {
    // 다기기 합산: 로컬(이 기기, SQLite 최신) + 타기기 캐시(없으면 0).
    // 여기서는 캐시 읽기만 — 네트워크 fetch 는 폴링 스레드(spawn_title_updater)가 담당하므로
    // watcher 파싱 직후 즉시 호출돼도 블로킹되지 않는다.
    let cost = crate::commands::today_cost_usd() + crate::aggregator::cached_other_devices_cost();
    let show_text = crate::commands::read_show_menubar_cost();
    let show_limits = crate::commands::read_show_menubar_limits();
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };

    #[cfg(target_os = "macos")]
    {
        let items = if show_limits {
            crate::oauth_usage::cached_usage()
                .map(|u| tray_items_from_usage(&u, chrono::Utc::now()))
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let cost_text =
            (show_text && cost >= 0.5).then(|| format!("${}", cost.round() as i64));

        if !items.is_empty() {
            let dark = is_dark_menubar();
            let key = format!(
                "{:?}|{}|{}",
                cost_text,
                items
                    .iter()
                    .map(|i| format!("{}{}", i.label, i.remaining_pct.round()))
                    .collect::<Vec<_>>()
                    .join(","),
                dark
            );
            let unchanged = LAST_RENDER_KEY.lock().map(|g| *g == key).unwrap_or(false);
            if unchanged {
                return;
            }
            let logo = tauri::image::Image::from_bytes(TRAY_ICON_BYTES).ok();
            let logo_ref = logo.as_ref().map(|img| (img.rgba(), img.width(), img.height()));
            if let Some((buf, w, h)) = crate::tray_render::render_status_strip(
                logo_ref,
                cost_text.as_deref(),
                &items,
                dark,
            ) {
                let _ = tray.set_icon(Some(tauri::image::Image::new_owned(buf, w, h)));
                let _ = tray.set_title(Some(String::new()));
                if let Ok(mut g) = LAST_RENDER_KEY.lock() {
                    *g = key;
                }
                return;
            }
            // 렌더 실패(폰트 없음 등) → 아래 텍스트 fallback 으로 진행.
        }

        // 한도 off / 캐시 없음 / 렌더 실패 — 기본 로고 + 기존 타이틀 방식.
        let was_custom = LAST_RENDER_KEY.lock().map(|g| !g.is_empty()).unwrap_or(false);
        if was_custom {
            if let Ok(icon) = tauri::image::Image::from_bytes(TRAY_ICON_BYTES) {
                let _ = tray.set_icon(Some(icon));
            }
            if let Ok(mut g) = LAST_RENDER_KEY.lock() {
                g.clear();
            }
        }
        let title = if show_text && cost >= 0.5 {
            format!(" ${}", cost.round() as i64)
        } else {
            String::new()
        };
        let _ = tray.set_title(Some(title));
    }

    #[cfg(not(target_os = "macos"))]
    {
        // 비-macOS: tooltip 에 텍스트로 동일 정보.
        let mut parts: Vec<String> = Vec::new();
        if show_text && cost >= 0.5 {
            parts.push(format!("오늘 ${}", cost.round() as i64));
        }
        if show_limits {
            if let Some(u) = crate::oauth_usage::cached_usage() {
                let items = tray_items_from_usage(&u, chrono::Utc::now());
                if !items.is_empty() {
                    parts.push(
                        items
                            .iter()
                            .map(|i| format!("{} {}%", i.label, i.remaining_pct.round() as i64))
                            .collect::<Vec<_>>()
                            .join(" · "),
                    );
                }
            }
        }
        let tooltip = if parts.is_empty() {
            "매드업 토큰 모니터".to_string()
        } else {
            format!("매드업 토큰 모니터 — {}", parts.join(" · "))
        };
        let _ = tray.set_tooltip(Some(tooltip));
    }
}
```

(c) `spawn_title_updater` 의 루프에 OAuth 캐시 갱신 추가 (Task 8 의 업로드 호출과 같은 위치 — 여기서는 fetch 만):

```rust
pub fn spawn_title_updater<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || loop {
        // 타기기 오늘 비용 — stale(120초)일 때만 Supabase fetch. blocking 은 이 전용 스레드에서만.
        crate::aggregator::refresh_other_devices_cost_if_stale();
        // OAuth 한도 — 10분 캐시 경유 (만료 시에만 네트워크). 트레이 한도 표시 +
        // Supabase 스냅샷 업로드(Task 8)의 데이터 소스.
        if crate::commands::read_show_menubar_limits() {
            let _ = crate::oauth_usage::get_usage_blocking();
        }
        refresh_tray_title(&app);
        std::thread::sleep(std::time::Duration::from_secs(30));
    });
}
```

> 주: Task 8 에서 이 `if read_show_menubar_limits()` 가드는 제거된다 (업로드는 토글과 무관하게 항상 필요). 이 태스크 시점에는 토글 on 일 때만 fetch.

(d) `src-tauri/src/lib.rs` 의 `pub mod tray;` 아래 (Step 2 에서 이미 추가):

```rust
pub mod tray_render;
```

- [ ] **Step 5: 전체 테스트/빌드**

Run: `cd src-tauri && cargo test 2>&1 | tail -3` → 전체 PASS
Run: `cd src-tauri && cargo build 2>&1 | tail -3` → 성공

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/tray_render.rs src-tauri/src/tray.rs src-tauri/src/lib.rs
git commit -m "feat: 트레이 한도 상태 스트립 이미지 렌더 (fontdue, 3단계 상태색 점)"
```

> ⚠️ **실기기 확인 필요 (사용자)**: `pnpm tauri dev` 후 Settings 에서 "메뉴바 Claude 잔여 한도 표시" on.
> Retina 에서 아이콘 크기가 2배로 보이거나 흐리면 `tray_render.rs` 의 `SCALE` 을 1 로 조정 (스펙 §2 리스크).
> 그래도 품질이 안 나오면 스펙의 fallback(아이콘에 점만 합성 + 텍스트 타이틀)으로 후속 처리.

---

### Task 7: Supabase — 계정 한도 스냅샷 스키마 + RPC (마이그레이션 0023)

**Files:**
- Create: `supabase/migrations/0023_claude_limit_snapshots.sql`

**Interfaces:**
- Produces (Task 8 의 Rust 업로드, Task 9 의 프론트 조회가 사용):
  - RPC `upsert_claude_limit_snapshot(p_account_uuid uuid, p_account_email text, p_windows jsonb, p_fetched_at timestamptz) returns void`
  - RPC `get_claude_account_limits() returns table(account_uuid uuid, account_email text, owner_email text, owner_name text, windows jsonb, fetched_at timestamptz, updated_at timestamptz)`

- [ ] **Step 1: 마이그레이션 파일 작성**:

```sql
-- 0023_claude_limit_snapshots.sql: 계정별 Claude 한도 스냅샷 공유 + 소유자 매핑
--
-- 배경: 팀이 같은 Claude 계정을 여러 명이 나눠 쓰고 기기의 로그인 계정도 수시로 바뀐다.
--   한도의 주체는 앱 유저(profile)가 아니라 Claude 계정 — 스냅샷 키 = oauthAccount.accountUuid.
--   같은 계정 row 를 여러 유저가 갱신해야 하므로 row 소유 RLS 대신 security definer RPC 경유.
--   업로드는 동의 토글 없이 전원 (2026-07-13 기획 확정 — 사내 도구, 쉐어 요청 유스케이스 전제).
--
-- windows jsonb 형식: [{"kind":"session","scope_model":null,"utilization":59.0,
--                       "resets_at":"2026-07-13T13:50:00+00:00"}, ...]

create table if not exists claude_limit_snapshots (
  account_uuid  uuid primary key,          -- ~/.claude.json oauthAccount.accountUuid
  account_email text not null,             -- oauthAccount.emailAddress
  windows       jsonb not null,
  fetched_at    timestamptz not null,      -- 클라이언트가 usage API 를 fetch 한 시각
  uploaded_by   uuid references profiles(id),
  updated_at    timestamptz not null default now()
);

alter table claude_limit_snapshots enable row level security;

drop policy if exists "authenticated read snapshots" on claude_limit_snapshots;
create policy "authenticated read snapshots"
  on claude_limit_snapshots for select to authenticated using (true);

-- 계정 → 소유자 수동 매핑 (공용/개인 이메일 계정 예외용).
-- v1 은 관리 UI 없음 — Supabase 직접 INSERT 로 운영 (스펙 §4.2).
create table if not exists claude_owner (
  account_email text primary key,
  owner_email   text not null
);

alter table claude_owner enable row level security;

drop policy if exists "authenticated read owner" on claude_owner;
create policy "authenticated read owner"
  on claude_owner for select to authenticated using (true);

-- 업로드 RPC — 오래된 fetched_at 이 최신 스냅샷을 덮지 않도록 가드.
create or replace function upsert_claude_limit_snapshot(
  p_account_uuid uuid,
  p_account_email text,
  p_windows jsonb,
  p_fetched_at timestamptz
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  insert into claude_limit_snapshots
    (account_uuid, account_email, windows, fetched_at, uploaded_by, updated_at)
  values
    (p_account_uuid, p_account_email, p_windows, p_fetched_at, auth.uid(), now())
  on conflict (account_uuid) do update
    set account_email = excluded.account_email,
        windows       = excluded.windows,
        fetched_at    = excluded.fetched_at,
        uploaded_by   = excluded.uploaded_by,
        updated_at    = now()
    where excluded.fetched_at >= claude_limit_snapshots.fetched_at;
end $$;

revoke all on function upsert_claude_limit_snapshot(uuid, text, jsonb, timestamptz) from public;
grant execute on function upsert_claude_limit_snapshot(uuid, text, jsonb, timestamptz) to authenticated;

-- 열람 RPC — 소유자 결정 규칙: claude_owner 매핑 → 계정 이메일 그대로.
-- 표시명은 결정된 owner_email 과 일치하는 profile 의 name (없으면 null → 프론트가 이메일 표시).
create or replace function get_claude_account_limits()
returns table (
  account_uuid uuid,
  account_email text,
  owner_email text,
  owner_name text,
  windows jsonb,
  fetched_at timestamptz,
  updated_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select
    s.account_uuid,
    s.account_email,
    coalesce(o.owner_email, s.account_email) as owner_email,
    p.name as owner_name,
    s.windows,
    s.fetched_at,
    s.updated_at
  from claude_limit_snapshots s
  left join claude_owner o on o.account_email = s.account_email
  left join profiles p on p.email = coalesce(o.owner_email, s.account_email)
$$;

revoke all on function get_claude_account_limits() from public;
grant execute on function get_claude_account_limits() to authenticated;
```

- [ ] **Step 2: supabase-cli-agent 로 적용** — Agent 도구로 `supabase-cli-agent` 호출. 프롬프트에 명시: "재위임 금지, 직접 실행. `supabase/migrations/0023_claude_limit_snapshots.sql` 을 prod 에 적용하고, 적용 후 `\d claude_limit_snapshots`, `\d claude_owner`, `\df+ upsert_claude_limit_snapshot`, `select * from get_claude_account_limits();` (빈 결과 OK) 로 검증 결과를 보고할 것."

Expected: 두 테이블 + 두 RPC 생성 확인, get_claude_account_limits() 가 0 rows 반환.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0023_claude_limit_snapshots.sql
git commit -m "feat: 계정별 Claude 한도 스냅샷 테이블/RPC (claude_limit_snapshots, claude_owner)"
```

---

### Task 8: Rust — 한도 스냅샷 Supabase 업로드

**Files:**
- Modify: `src-tauri/src/aggregator.rs`
- Modify: `src-tauri/src/tray.rs` (폴링 루프에서 호출)

**Interfaces:**
- Consumes: Task 1 `get_usage_blocking()`/`OAuthUsage`, Task 2 `read_claude_account()`, Task 7 RPC `upsert_claude_limit_snapshot`, aggregator 의 `SESSION` 캐시
- Produces: `pub fn upload_limit_snapshot_if_fresh()` — blocking, 폴링 스레드 전용

- [ ] **Step 1: 업로드 함수 구현** — `aggregator.rs` 의 `refresh_other_devices_cost_if_stale` 아래에 추가:

```rust
/// 마지막으로 업로드한 스냅샷의 fetched_at — 같은 데이터 재업로드 방지.
static LAST_LIMITS_UPLOAD: Mutex<Option<String>> = Mutex::new(None);

/// 계정 단위 Claude 한도 스냅샷을 Supabase 에 upsert.
/// blocking(ureq) — 30초 폴링 스레드(spawn_title_updater) 전용. 파싱 경로에서 호출 금지.
/// 동의 토글 없음 — 로그인 상태면 항상 업로드 (스펙 §4.3, 2026-07-13 기획 확정).
/// OAuth 캐시(10분)가 갱신됐을 때만 실제 네트워크 업로드가 발생한다 (fetched_at dedup).
pub fn upload_limit_snapshot_if_fresh() {
    let session = {
        let Ok(guard) = SESSION.lock() else { return };
        match guard.as_ref() {
            Some(s) => s.clone(),
            None => return, // 미로그인 — 업로드 없음
        }
    };
    let Some(account) = crate::oauth_usage::read_claude_account() else {
        return; // ~/.claude.json 없음 / oauthAccount 없음 — 로컬 표시만 (스펙 §5)
    };
    let usage = match crate::oauth_usage::get_usage_blocking() {
        Ok(u) => u,
        Err(_) => return, // 토큰 없음/429 등 — 다음 사이클 재시도
    };
    if usage.is_stale || usage.windows.is_empty() {
        return;
    }
    {
        let Ok(guard) = LAST_LIMITS_UPLOAD.lock() else { return };
        if guard.as_deref() == Some(usage.fetched_at.as_str()) {
            return; // 캐시 미갱신 — 이미 올린 스냅샷
        }
    }
    if uuid::Uuid::try_parse(&account.uuid).is_err() {
        return; // account_uuid 컬럼이 uuid 타입 — 방어
    }

    let url = format!(
        "{}/rest/v1/rpc/upsert_claude_limit_snapshot",
        session.supabase_url
    );
    let body = serde_json::json!({
        "p_account_uuid": account.uuid,
        "p_account_email": account.email,
        "p_windows": usage.windows,
        "p_fetched_at": usage.fetched_at,
    });
    let resp = ureq::post(&url)
        .set("apikey", &session.publishable_key)
        .set("Authorization", &format!("Bearer {}", session.access_token))
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(10))
        .send_json(body);
    match resp {
        Ok(_) => {
            if let Ok(mut guard) = LAST_LIMITS_UPLOAD.lock() {
                *guard = Some(usage.fetched_at);
            }
        }
        Err(e) => eprintln!("[limit-snapshot] upload failed: {e}"),
    }
}
```

- [ ] **Step 2: 폴링 루프 연결** — `tray.rs` 의 `spawn_title_updater` 를 교체 (Task 6 의 토글 가드 제거 — 업로드는 토글과 무관):

```rust
pub fn spawn_title_updater<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || loop {
        // 타기기 오늘 비용 — stale(120초)일 때만 Supabase fetch. blocking 은 이 전용 스레드에서만.
        crate::aggregator::refresh_other_devices_cost_if_stale();
        // OAuth 한도 fetch(10분 캐시) + 계정 스냅샷 업로드 — 트레이 토글과 무관하게 항상.
        // 업로드 함수 내부에서 fetch 하므로 별도 get_usage_blocking 호출 불필요.
        crate::aggregator::upload_limit_snapshot_if_fresh();
        refresh_tray_title(&app);
        std::thread::sleep(std::time::Duration::from_secs(30));
    });
}
```

- [ ] **Step 3: 빌드/테스트**

Run: `cd src-tauri && cargo test 2>&1 | tail -3` → 전체 PASS
Run: `cd src-tauri && cargo build 2>&1 | tail -3` → 성공

- [ ] **Step 4: 런타임 검증 (supabase-cli-agent, 앱 실행 후)**

`pnpm tauri dev` 로 앱을 띄워 로그인 상태로 1분 대기 후, supabase-cli-agent 에 위임:
"재위임 금지, 직접 실행: `select account_email, jsonb_array_length(windows) as n_windows, fetched_at, updated_at from claude_limit_snapshots;`"
Expected: 이 기기 계정 1 row, n_windows ≥ 2.
(앱 실행이 어려운 세션이면 이 검증은 사용자 실기기 체크리스트로 이월.)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/aggregator.rs src-tauri/src/tray.rs
git commit -m "feat: 계정 한도 스냅샷 Supabase 업로드 (30초 폴링 편승, fetched_at dedup)"
```

---

### Task 9: Frontend — "계정 한도" 페이지 + 라우트/네비/i18n

**Files:**
- Modify: `src/types/models.ts` (ClaudeAccountLimitRow)
- Modify: `src/hooks/useRateLimits.ts` (useClaudeAccountLimits + mock)
- Create: `src/pages/AccountLimits.tsx`
- Modify: `src/App.tsx` (라우트), `src/components/layout/Sidebar.tsx` (네비), `src/i18n/ko.json` (nav 키)

**Interfaces:**
- Consumes: Task 7 RPC `get_claude_account_limits`, Task 3 `lib/limits.ts` 헬퍼, Task 4 `StatusDot`, 공유 `Segmented`/`QuotaSegBar`
- Produces: 라우트 `/limits`, 네비 키 `nav.accountLimits`

- [ ] **Step 1: 타입 추가** — `src/types/models.ts` 의 `LimitWindow` 아래:

```ts
/// get_claude_account_limits RPC row — 계정 한도 페이지.
export interface ClaudeAccountLimitRow {
  account_uuid: string;
  account_email: string;
  owner_email: string;
  owner_name: string | null;
  windows: LimitWindow[];
  fetched_at: string;
  updated_at: string;
}
```

- [ ] **Step 2: 조회 훅 + mock** — `src/hooks/useRateLimits.ts` 에 추가 (`supabase` import 필요):

```ts
import { supabase } from "@/lib/supabase";
import type {
  CodexRateLimitSnapshot,
  ClaudeAccountLimitRow,
  LimitWindow,
} from "@/types/models";
```

```ts
function buildMockAccountLimits(): ClaudeAccountLimitRow[] {
  const now = Date.now();
  const reset5h = new Date(now + 2 * 3_600_000).toISOString();
  const resetWk = new Date(now + 5 * 86_400_000).toISOString();
  const acct = (
    uuid: string,
    email: string,
    name: string | null,
    u5: number,
    u7: number,
    uf: number,
    updatedAgoMin: number,
  ): ClaudeAccountLimitRow => ({
    account_uuid: uuid,
    account_email: email,
    owner_email: email,
    owner_name: name,
    windows: [
      { kind: "session", scope_model: null, utilization: u5, resets_at: reset5h },
      { kind: "weekly_all", scope_model: null, utilization: u7, resets_at: resetWk },
      { kind: "weekly_scoped", scope_model: "Fable", utilization: uf, resets_at: resetWk },
    ],
    fetched_at: new Date(now - updatedAgoMin * 60_000).toISOString(),
    updated_at: new Date(now - updatedAgoMin * 60_000).toISOString(),
  });
  return [
    acct("00000000-0000-0000-0000-000000000001", "hong@madup.com", "홍길동", 8, 12, 5, 3),
    acct("00000000-0000-0000-0000-000000000002", "kim@madup.com", "김철수", 59, 37, 48, 7),
    acct("00000000-0000-0000-0000-000000000003", "lee@madup.com", "이영희", 88, 70, 100, 45),
  ];
}

export function useClaudeAccountLimits() {
  return useQuery<ClaudeAccountLimitRow[]>({
    queryKey: ["claudeAccountLimits"],
    queryFn: async () => {
      if (IS_MOCK) return delay(buildMockAccountLimits());
      const { data, error } = await supabase.rpc("get_claude_account_limits");
      if (error) throw new Error(error.message);
      return (data ?? []) as ClaudeAccountLimitRow[];
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
}
```

- [ ] **Step 3: 페이지 생성** — `src/pages/AccountLimits.tsx`:

```tsx
import { useState } from "react";
import { QuotaSegBar } from "@/components/ui/QuotaSegBar";
import { Segmented } from "@/components/ui/Segmented";
import { StatusDot } from "@/components/ui/StatusDot";
import { quotaSignalClass } from "@/components/ui/quotaSignal";
import { useClaudeAccountLimits } from "@/hooks/useRateLimits";
import {
  formatRelativeTimeKo,
  formatResetKo,
  minRemaining,
  remainingPct,
  sortByRemainingDesc,
  windowShortLabel,
  type SortKind,
} from "@/lib/limits";
import type { ClaudeAccountLimitRow } from "@/types/models";

const SORT_OPTIONS: { value: SortKind; label: string }[] = [
  { value: "weekly_scoped", label: "Fable" },
  { value: "weekly_all", label: "주간" },
  { value: "session", label: "5시간" },
];

/// 마지막 갱신 30분 초과 → 흐리게 (죽은 데이터 오인 방지, 스펙 §4.4).
const STALE_MS = 30 * 60_000;

/// 사이드바 "계정 한도" — 계정별 Claude 잔여 한도/리셋 현황. 쉐어 요청 판단용.
export default function AccountLimits() {
  const { data: rows = [], isLoading, error } = useClaudeAccountLimits();
  const [sortKind, setSortKind] = useState<SortKind>("weekly_scoped");
  const nowMs = Date.now();
  const sorted = sortByRemainingDesc(rows, (r) => r.windows, sortKind);

  return (
    <div className="px-7 pt-5 pb-8">
      <header className="flex items-center justify-between mb-5 gap-3">
        <div>
          <h1 className="text-[18px] font-bold text-text-primary">계정 한도</h1>
          <p className="text-[12px] text-text-tertiary mt-1">
            계정별 Claude 잔여 한도 — 여유 있는 계정에 쉐어를 요청하세요. 잔여 많은 순 정렬.
          </p>
        </div>
        <Segmented
          value={sortKind}
          onChange={setSortKind}
          options={SORT_OPTIONS}
          ariaLabel="정렬 기준 한도 창"
        />
      </header>

      {isLoading ? (
        <EmptyState text="불러오는 중…" />
      ) : error ? (
        <EmptyState text={`조회 실패: ${error instanceof Error ? error.message : String(error)}`} />
      ) : sorted.length === 0 ? (
        <EmptyState text="아직 수집된 계정 한도가 없습니다. 각자 앱을 실행하고 있으면 자동으로 올라옵니다." />
      ) : (
        <div className="flex flex-col gap-2">
          {sorted.map((row) => (
            <AccountRow key={row.account_uuid} row={row} nowMs={nowMs} />
          ))}
        </div>
      )}
    </div>
  );
}

function AccountRow({
  row,
  nowMs,
}: {
  readonly row: ClaudeAccountLimitRow;
  readonly nowMs: number;
}) {
  const updatedMs = new Date(row.updated_at).getTime();
  const stale = !Number.isFinite(updatedMs) || nowMs - updatedMs > STALE_MS;
  const min = minRemaining(row.windows);
  const resetCandidates = row.windows
    .map((w) => new Date(w.resets_at).getTime())
    .filter((ms) => Number.isFinite(ms) && ms > nowMs);
  const soonestReset = resetCandidates.length > 0 ? Math.min(...resetCandidates) : null;

  return (
    <div
      className={`mc-card flex items-center gap-4 px-4 py-3 ${stale ? "opacity-50" : ""}`}
    >
      <StatusDot remaining={min === null ? null : min / 100} size={9} />
      <div className="min-w-0 w-44 shrink-0">
        <div className="text-[13px] font-semibold text-text-primary truncate">
          {row.owner_name ?? row.owner_email}
        </div>
        <div className="text-[11px] text-text-tertiary truncate" title={row.account_email}>
          {row.account_email}
        </div>
      </div>
      <div className="flex-1 grid grid-cols-3 gap-4 min-w-0">
        {row.windows.map((w, i) => {
          const remaining = remainingPct(w.utilization);
          return (
            <div key={`${w.kind}:${w.scope_model ?? i}`} className="min-w-0">
              <div className="flex items-center justify-between mb-1 gap-2">
                <span className="text-[10.5px] font-semibold text-text-secondary">
                  {windowShortLabel(w)}
                </span>
                <span className={`num text-[11.5px] ${quotaSignalClass(remaining / 100)}`}>
                  {remaining}%
                </span>
              </div>
              <QuotaSegBar
                value={remaining / 100}
                segments={8}
                label={`${windowShortLabel(w)} 잔여`}
              />
            </div>
          );
        })}
      </div>
      <div className="text-right shrink-0 w-32">
        <div className="num text-[11px] text-text-secondary">
          {soonestReset === null ? "갱신 대기" : `리셋 ${formatResetKo(soonestReset)}`}
        </div>
        <div className="text-[10px] text-text-faint mt-0.5">
          {Number.isFinite(updatedMs) ? `${formatRelativeTimeKo(nowMs - updatedMs)} 전 갱신` : "—"}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ text }: { readonly text: string }) {
  return (
    <div className="grid place-items-center rounded-[10px] border border-hairline bg-surface-2 px-6 py-14 text-center">
      <p className="text-[13px] text-text-secondary">{text}</p>
    </div>
  );
}
```

- [ ] **Step 4: 라우트/네비/i18n**

(a) `src/App.tsx` — import 와 라우트 추가:

```tsx
import AccountLimits from "@/pages/AccountLimits";
```

`<Route path="/team/admin" ... />` 아래:

```tsx
              <Route path="/limits" element={<AccountLimits />} />
```

(b) `src/components/layout/Sidebar.tsx` — `NAV_ITEMS` 의 `/team` 항목 뒤에 추가 (team 그룹, 전원 노출):

```tsx
  {
    to: "/limits",
    end: true,
    labelKey: "nav.accountLimits",
    group: "team",
    icon: (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="1.5" y="5" width="11" height="6" rx="1.5" />
        <path d="M14.5 7v2" strokeLinecap="round" />
        <rect x="3" y="6.5" width="4.5" height="3" rx="0.6" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
```

(c) `src/i18n/ko.json` — `nav` 객체에 추가:

```json
    "accountLimits": "계정 한도",
```

- [ ] **Step 5: 테스트/빌드/육안**

Run: `pnpm test 2>&1 | tail -3` → PASS
Run: `pnpm build 2>&1 | tail -3` → 성공
Run: `pnpm dev` → 사이드바 Team 그룹에 "계정 한도" → mock 3계정: 이영희(잔여 많음)가 Fable 정렬 기준 위? — mock 값 기준 정렬 확인: Fable 잔여 홍길동 95 > 김철수 52 > 이영희 0. 이영희 행은 45분 전 갱신 → 흐림. Segmented 를 "5시간" 으로 바꾸면 순서 변경.

- [ ] **Step 6: Commit**

```bash
git add src/types/models.ts src/hooks/useRateLimits.ts src/pages/AccountLimits.tsx src/App.tsx src/components/layout/Sidebar.tsx src/i18n/ko.json
git commit -m "feat: 계정 한도 페이지 신설 (계정별 잔여 배터리·리셋·정렬, /limits)"
```

---

### Task 10: 문서 동기화 + 최종 검증

**Files:**
- Modify: `.claude/CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-07-13-claude-limit-battery-design.md` (구현 중 변경 사항 있으면만)

- [ ] **Step 1: CLAUDE.md 갱신** (기존 구조 유지, 관련 항목만):

(a) §2 디렉토리 구조의 `src-tauri/src/` 목록에서 `oauth_usage.rs` 줄 교체 + `tray_render.rs` 줄 추가:

```
│       ├── oauth_usage.rs  # Anthropic 비공개 endpoint (limits 배열 → windows 일반화, 계정 식별)
│       └── tray_render.rs  # 트레이 한도 상태 스트립 RGBA 렌더 (fontdue)
```

(b) §7 데이터 흐름 끝에 추가:

```
oauth_usage.rs (10분 캐시) → 트레이 상태 스트립(tray_render) + 대시보드 한도 패널(잔여 배터리)
  ↓ (30초 폴링 스레드, fetched_at dedup)
aggregator.rs::upload_limit_snapshot_if_fresh → Supabase claude_limit_snapshots (계정 단위 upsert)
  ↓ RPC get_claude_account_limits (+ claude_owner 소유자 매핑)
AccountLimits 페이지 (/limits — 계정별 잔여/리셋, Fable 잔여순)
```

(c) §8 공유 컴포넌트 표에 한 줄 추가:

```
  | 3단계 잔여 상태 점 (초록/노랑/빨강, 이모지 대체) | `@/components/ui/StatusDot` | UsageLimitPanel, AccountLimits |
```

(d) §8 아래에 컨벤션 한 줄 추가 (quotaSignal 의미 반전 주의):

```
  - **`quotaSignal`/`QuotaSegBar` 의 입력은 "잔여 비율"(배터리 의미)** — 사용률을 넘기면 색이 반대로 나온다. 잔여 ≥70% lime / ≥30% amber / <30% coral.
```

- [ ] **Step 2: 최종 검증 일괄 실행**

```bash
cd src-tauri && cargo test 2>&1 | tail -3 && cd ..
pnpm test 2>&1 | tail -3
pnpm build 2>&1 | tail -3
grep -rn "function Kpi\|function Legend\|function Segmented" src/ | grep -v components/ui  # 인라인 재정의 없어야 함
grep -rn '<select' src/  # native select 없어야 함
```

Expected: 전부 PASS / 출력 없음.

- [ ] **Step 3: Commit**

```bash
git add .claude/CLAUDE.md
git commit -m "docs: CLAUDE.md 한도 배터리/계정 한도 공유 반영"
```

- [ ] **Step 4: 사용자 실기기 체크리스트 안내** (플랜 종료 메시지에 포함):

1. `pnpm tauri dev` → Dashboard 한도 패널: Fable 행 표시 + 잔여 % + 리셋 시각.
2. Settings → "메뉴바 Claude 잔여 한도 표시" on → 메뉴바에 로고+점+숫자 스트립. **크기/선명도 확인** (문제 시 `tray_render.rs` `SCALE` 1 로).
3. 라이트/다크 메뉴바 각각에서 글자 가독성.
4. 로그인 상태 1분 후 "계정 한도" 페이지에 본인 계정 row.
5. Supabase `claude_limit_snapshots` row 확인 (supabase-cli-agent).
