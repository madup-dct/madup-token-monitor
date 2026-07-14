// Anthropic의 비공개 OAuth Usage API로 5h/7d 사용량 조회.
// Claude Code가 macOS Keychain (또는 ~/.claude/.credentials.json)에 저장한 OAuth 토큰을
// 그대로 사용해서 Bearer 인증한다. 토큰은 외부로 전송하지 않으며, 응답값은 메모리 캐시에만 보관.
//
// soulduse/ai-token-monitor 의 oauth_usage.rs 를 단순화한 포팅.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

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

struct CacheEntry {
    usage: OAuthUsage,
    fetched_at: Instant,
}

static OAUTH_CACHE: Mutex<Option<CacheEntry>> = Mutex::new(None);
static RATE_LIMIT_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);

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

fn read_oauth_token() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        if let Some(t) = read_oauth_token_keychain() {
            return Some(t);
        }
    }
    read_oauth_token_file()
}

#[cfg(target_os = "macos")]
fn read_oauth_token_keychain() -> Option<String> {
    use std::process::Command;

    let account = std::env::var("USER").ok()?;
    // Claude Code v1: legacy service name. v2.1.52+ uses suffix hashes.
    let candidates = [
        "Claude Code-credentials".to_string(),
    ];

    for service in &candidates {
        let output = Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", service, "-a", &account, "-w"])
            .output()
            .ok()?;
        if !output.status.success() {
            continue;
        }
        if let Some(token) = extract_token_from_keychain_data(&output.stdout) {
            return Some(token);
        }
    }
    None
}

fn extract_token_from_keychain_data(data: &[u8]) -> Option<String> {
    let json_str = String::from_utf8_lossy(data);
    let json_str = json_str.trim_start_matches(|c: char| !c.is_ascii() || c == '\x07');
    let value: serde_json::Value = serde_json::from_str(json_str).ok()?;
    value
        .get("claudeAiOauth")?
        .get("accessToken")?
        .as_str()
        .map(|s| s.to_string())
}

fn read_oauth_token_file() -> Option<String> {
    let dir: PathBuf = std::env::var("CLAUDE_CONFIG_DIR")
        .ok()
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".claude")))?;
    let path = dir.join(".credentials.json");
    let content = std::fs::read_to_string(&path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&content).ok()?;
    value
        .get("claudeAiOauth")?
        .get("accessToken")?
        .as_str()
        .map(|s| s.to_string())
}

fn fetch_usage_from_api(token: &str) -> Result<OAuthUsage, String> {
    let resp = ureq::get("https://api.anthropic.com/api/oauth/usage")
        .set("Authorization", &format!("Bearer {}", token))
        .set("anthropic-beta", "oauth-2025-04-20")
        .set("Content-Type", "application/json")
        .set("User-Agent", "claude-code/1.0.0")
        .call();

    match resp {
        Ok(r) => {
            let api: ApiResponse = r.into_json().map_err(|e| format!("JSON parse: {e}"))?;
            Ok(OAuthUsage {
                windows: windows_from_api(&api),
                fetched_at: chrono::Local::now().to_rfc3339(),
                is_stale: false,
            })
        }
        Err(ureq::Error::Status(429, response)) => {
            let retry_after = response
                .header("retry-after")
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(300);
            if let Ok(mut guard) = RATE_LIMIT_UNTIL.lock() {
                *guard = Some(Instant::now() + std::time::Duration::from_secs(retry_after));
            }
            Err(format!("Rate limited (429), retry after {retry_after}s"))
        }
        Err(ureq::Error::Status(code, _)) => Err(format!("HTTP {code}")),
        Err(ureq::Error::Transport(e)) => Err(format!("Transport: {e}")),
    }
}

fn get_oauth_usage_impl(force: bool) -> Result<OAuthUsage, String> {
    // 1) rate-limit window
    if let Ok(guard) = RATE_LIMIT_UNTIL.lock() {
        if let Some(until) = *guard {
            if Instant::now() < until {
                if let Ok(cache) = OAUTH_CACHE.lock() {
                    if let Some(ref e) = *cache {
                        let mut u = e.usage.clone();
                        u.is_stale = true;
                        return Ok(u);
                    }
                }
                return Err("rate-limited".into());
            }
        }
    }

    // 2) fresh cache (10분 미만, force일 땐 skip)
    if !force {
        if let Ok(cache) = OAUTH_CACHE.lock() {
            if let Some(ref e) = *cache {
                if e.fetched_at.elapsed().as_secs() < 600 {
                    return Ok(e.usage.clone());
                }
            }
        }
    }

    // 3) fetch
    let token = read_oauth_token().ok_or_else(|| {
        "Claude Code OAuth 토큰을 찾을 수 없습니다. Claude Code에 로그인되어 있는지 확인해주세요."
            .to_string()
    })?;
    let usage = fetch_usage_from_api(&token)?;

    if let Ok(mut cache) = OAUTH_CACHE.lock() {
        *cache = Some(CacheEntry {
            usage: usage.clone(),
            fetched_at: Instant::now(),
        });
    }
    Ok(usage)
}

/// 캐시된 사용량 읽기 — 네트워크 호출 없음. 트레이 즉시 경로(refresh_tray_title)용.
pub fn cached_usage() -> Option<OAuthUsage> {
    OAUTH_CACHE.lock().ok()?.as_ref().map(|e| e.usage.clone())
}

/// 10분 캐시 경유 fetch (만료 시에만 네트워크). blocking — 폴링 스레드 전용.
pub fn get_usage_blocking() -> Result<OAuthUsage, String> {
    get_oauth_usage_impl(false)
}

#[tauri::command]
pub fn get_oauth_usage() -> Result<OAuthUsage, String> {
    get_oauth_usage_impl(false)
}

#[tauri::command]
pub fn refresh_oauth_usage() -> Result<OAuthUsage, String> {
    get_oauth_usage_impl(true)
}

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
