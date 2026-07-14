// 사내 집계 업로드 — 로컬 SQLite의 toks/cost/MCP/플러그인 카운트를 Supabase로 upsert.
// 원본 메시지/프롬프트는 절대 업로드하지 않는다. 카운트와 합계만.
//
// 전제조건: 호출자가 share_consent=true임을 확인한 뒤에만 호출.
// user_id는 호출자가 인증된 Supabase 세션의 auth.uid()를 넘김 — RLS WITH CHECK 통과용.

use chrono::{Local, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::hash::Hash;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::db;

// =============================================================================
// Supabase 세션 메모리 캐시 + 타기기 오늘 비용 (트레이 표시용)
// =============================================================================

/// Rust 측은 Supabase 세션을 영속하지 않는다 — supabase-js 세션은 webview localStorage 에만
/// 있으므로, 프론트가 앱 시작/SIGNED_IN/TOKEN_REFRESHED 시 set_supabase_session 으로 밀어넣고
/// sync_aggregates_now 호출 시에도 같이 갱신한다.
/// Debug 미파생 — access_token 평문 보유라 `{:?}` 한 줄로 JWT 가 로그에 새는 것을 차단.
#[derive(Clone)]
struct SupabaseSession {
    supabase_url: String,
    publishable_key: String,
    access_token: String,
    user_id: String,
}

static SESSION: Mutex<Option<SupabaseSession>> = Mutex::new(None);

fn store_session(session: SupabaseSession) {
    if let Ok(mut guard) = SESSION.lock() {
        *guard = Some(session);
    }
}

/// Tauri command: 프론트의 Supabase 세션(JWT)을 Rust 메모리 캐시에 등록.
/// 트레이의 다기기 비용 조회가 이 세션으로 usage_aggregates RLS 를 통과한다.
/// 세션 등록의 유일한 진입점 — 검증을 우회하는 경로를 만들지 말 것.
#[tauri::command]
pub fn set_supabase_session(
    supabase_url: String,
    publishable_key: String,
    access_token: String,
    user_id: String,
) {
    // webview 가 넘긴 값 방어 — Bearer 토큰이 비-https 호스트로 나가거나
    // 조작된 user_id 필터로 타 사용자 비용이 합산에 섞이는 것을 차단.
    if !supabase_url.starts_with("https://") || uuid::Uuid::try_parse(&user_id).is_err() {
        eprintln!("[session-bridge] rejected session: invalid url scheme or user_id");
        return;
    }
    store_session(SupabaseSession {
        supabase_url,
        publishable_key,
        access_token,
        user_id,
    });
}

/// Tauri command: 로그아웃 시 세션·타기기 비용 캐시 제거.
/// 이전 사용자 JWT 로 폴링이 계속되거나 이전 사용자 비용이 트레이에 잔류하는 것을 방지.
#[tauri::command]
pub fn clear_supabase_session(app: tauri::AppHandle) {
    if let Ok(mut guard) = SESSION.lock() {
        *guard = None;
    }
    if let Ok(mut guard) = OTHER_DEVICE_COST.lock() {
        *guard = None;
    }
    // 다음 30초 폴링을 기다리지 않고 즉시 로컬 비용만으로 갱신.
    crate::tray::refresh_tray_title(&app);
}

/// 타기기 오늘 비용 TTL 캐시.
/// fetched_at 은 "마지막 시도" 시각 — fetch 실패 시에도 갱신해 네트워크 장애 중
/// 30초 폴링마다 재시도가 반복되는 것을 막는다 (값은 직전 성공값 유지).
/// date/user_id 는 값의 유효 맥락 — 자정이 지나거나(어제 합) 사용자가 바뀌면
/// 읽기 시점에 무효 처리해 stale 값이 새 맥락에 합산되는 것을 차단한다.
struct RemoteCostCache {
    value: f64,
    date: String,
    user_id: String,
    fetched_at: Instant,
}

static OTHER_DEVICE_COST: Mutex<Option<RemoteCostCache>> = Mutex::new(None);
const OTHER_DEVICE_COST_TTL: Duration = Duration::from_secs(120);

/// usage_aggregates 응답 row — 트레이 비용 합산에 필요한 최소 컬럼만 select.
#[derive(Debug, Deserialize)]
struct RemoteCostRow {
    device_id: String,
    total_cost_usd: Option<f64>,
}

/// 순수 합산 — DB 행들 중 타기기(device_id ≠ 내 것) 비용만.
/// 내 device_id 행은 로컬 SQLite 가 더 최신이므로 제외하고 표시 시점에 로컬 값으로 대체
/// (이중계상/누락 방지).
fn sum_other_devices_cost(remote_rows: &[RemoteCostRow], my_device_id: &str) -> f64 {
    remote_rows
        .iter()
        .filter(|r| r.device_id != my_device_id)
        .map(|r| r.total_cost_usd.unwrap_or(0.0))
        .sum::<f64>()
}

/// 캐시된 "타기기 오늘 비용" 읽기 — 네트워크 호출 없음.
/// watcher 즉시 경로(refresh_tray_title)에서 호출해도 안전.
/// 캐시 없음 / 날짜가 오늘이 아님(자정 경과) / 현 세션 사용자와 불일치(로그아웃·전환)
/// 이면 0 — stale 값이 오늘 비용에 합산되는 것을 막는다.
pub fn cached_other_devices_cost() -> f64 {
    let current_user = SESSION
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|s| s.user_id.clone()));
    let Some(user) = current_user else { return 0.0 };
    let Some(today) = local_date_string(Utc::now().timestamp_millis()) else {
        return 0.0;
    };
    OTHER_DEVICE_COST
        .lock()
        .ok()
        .and_then(|g| {
            g.as_ref()
                .filter(|c| c.date == today && c.user_id == user)
                .map(|c| c.value)
        })
        .unwrap_or(0.0)
}

/// 캐시가 stale(TTL 120초 초과)할 때만 Supabase 에서 타기기 오늘 비용을 다시 가져온다.
/// blocking(ureq) — 30초 폴링 스레드(spawn_title_updater) 전용. 파싱 경로에서 호출 금지.
/// 세션 없음/네트워크 실패 시 조용히 기존 캐시 유지 → 트레이는 로컬 비용만 표시.
pub fn refresh_other_devices_cost_if_stale() {
    // 메뉴바 비용 표시가 꺼져 있으면 결과의 유일한 소비처가 없다 — 네트워크 생략.
    if !crate::commands::read_show_menubar_cost() {
        return;
    }
    {
        let Ok(guard) = OTHER_DEVICE_COST.lock() else {
            return;
        };
        if let Some(c) = guard.as_ref() {
            if c.fetched_at.elapsed() < OTHER_DEVICE_COST_TTL {
                return;
            }
        }
    }
    let session = {
        let Ok(guard) = SESSION.lock() else { return };
        match guard.as_ref() {
            Some(s) => s.clone(),
            None => return, // 미로그인 — 로컬 비용만
        }
    };
    let Ok(device_id) = crate::commands::get_or_create_device_id() else {
        return;
    };
    let Some(today) = local_date_string(Utc::now().timestamp_millis()) else {
        return;
    };

    let new_entry = match fetch_other_devices_today_cost(&session, &device_id, &today) {
        Ok(v) => RemoteCostCache {
            value: v,
            date: today,
            user_id: session.user_id.clone(),
            fetched_at: Instant::now(),
        },
        Err(e) => {
            eprintln!("[tray-cost] remote fetch failed: {e}");
            // 직전 성공값의 맥락(date/user)을 유지한 채 시도 시각만 갱신 —
            // 자정/사용자 전환 시 읽기 측 검증이 자연 무효화한다.
            let Ok(mut guard) = OTHER_DEVICE_COST.lock() else { return };
            if let Some(c) = guard.as_mut() {
                c.fetched_at = Instant::now();
            }
            return;
        }
    };
    // write-back 가드 — fetch 중 로그아웃/사용자 전환이 일어났으면 폐기.
    // clear_supabase_session 이 비운 캐시를 이전 사용자 비용으로 되살리지 않는다.
    // (락은 순차로만 잡는다 — SESSION 확인 후 해제, 그 다음 캐시 lock. 중첩 금지.)
    let still_same_user = SESSION
        .lock()
        .ok()
        .and_then(|s| s.as_ref().map(|s| s.user_id == new_entry.user_id))
        .unwrap_or(false);
    if still_same_user {
        if let Ok(mut guard) = OTHER_DEVICE_COST.lock() {
            *guard = Some(new_entry);
        }
    }
}

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

/// GET /rest/v1/usage_aggregates — 오늘(로컬 YYYY-MM-DD) 내 행들에서 타기기 합 계산.
/// RLS 가 본인 row SELECT 만 허용하지만 user_id=eq 필터를 명시해 의도를 분명히 한다.
fn fetch_other_devices_today_cost(
    session: &SupabaseSession,
    my_device_id: &str,
    today: &str,
) -> Result<f64, String> {
    let url = format!(
        "{}/rest/v1/usage_aggregates?user_id=eq.{}&date=eq.{}&select=device_id,total_cost_usd",
        session.supabase_url, session.user_id, today
    );
    let resp = ureq::get(&url)
        .set("apikey", &session.publishable_key)
        .set("Authorization", &format!("Bearer {}", session.access_token))
        // read timeout — 무설정 시 half-open TCP/슬립 복귀에서 영구 블록되어
        // 트레이 폴링 스레드(유일한 갱신 주체)가 죽는다.
        .timeout(Duration::from_secs(10))
        .call();
    let rows: Vec<RemoteCostRow> = match resp {
        Ok(r) => r.into_json().map_err(|e| format!("parse: {e}"))?,
        Err(ureq::Error::Status(code, response)) => {
            let body = response.into_string().unwrap_or_default();
            return Err(format!("HTTP {code}: {body}"));
        }
        Err(ureq::Error::Transport(e)) => return Err(format!("Transport: {e}")),
    };
    Ok(sum_other_devices_cost(&rows, my_device_id))
}

/// 우리 Supabase usage_aggregates row 형태
/// total_tokens = input + output + cache_read + cache_write — 대시보드 sumIO와 동일.
#[derive(Debug, Serialize)]
struct UsageAggregate {
    user_id: String,
    device_id: String,
    date: String,
    source: String,
    total_input: i64,
    total_output: i64,
    total_tokens: i64,
    total_cost_usd: f64,
}

#[derive(Debug, Serialize)]
struct McpUsageRow {
    user_id: String,
    device_id: String,
    date: String,
    mcp_server: String,
    count: i64,
}

#[derive(Debug, Serialize)]
struct PluginUsageRow {
    user_id: String,
    device_id: String,
    date: String,
    plugin_id: String,
    count: i64,
}

/// tool_usage row — tool_name 별 일별 호출 수.
#[derive(Debug, Serialize)]
struct ToolUsageRow {
    user_id: String,
    device_id: String,
    date: String,
    tool_name: String,
    count: i64,
}

/// usage_hourly row 형태 — UTC 정시(hour) 버킷.
/// (user_id, hour_utc, source, model, device_id) PK.
#[derive(Debug, Serialize)]
struct HourlyRow {
    user_id: String,
    device_id: String,
    hour_utc: String,
    source: String,
    model: String,
    input_tokens: i64,
    output_tokens: i64,
    cache_read: i64,
    cache_write: i64,
    cost_usd: f64,
    request_count: i64,
}

/// unix_ms timestamp을 local timezone YYYY-MM-DD 문자열로.
/// 로컬 일자 기준이라야 한국 사용자가 인식하는 "5/9 작업"이 정확히 5/9에 들어감.
fn local_date_string(ts_ms: i64) -> Option<String> {
    let secs = ts_ms / 1000;
    let nanos = ((ts_ms % 1000) * 1_000_000) as u32;
    Local.timestamp_opt(secs, nanos).single().map(|dt| dt.format("%Y-%m-%d").to_string())
}

/// unix_ms 를 UTC 정시(hour) 버킷 RFC3339 문자열로 (예: "2026-06-02T08:00:00Z").
/// timestamptz 컬럼이 그대로 파싱. 분/초는 0 으로 절삭.
fn utc_hour_string(ts_ms: i64) -> Option<String> {
    let secs = ts_ms / 1000;
    let hour_secs = secs - secs.rem_euclid(3600);
    Utc.timestamp_opt(hour_secs, 0)
        .single()
        .map(|dt| dt.format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

fn read_usage_aggregates(user_id: &str, device_id: &str) -> Result<Vec<UsageAggregate>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT ts, source, input_tokens, output_tokens,
                    cache_read, cache_write, cost_usd
             FROM usage_events",
        )
        .map_err(|e| e.to_string())?;

    // (date, source) → (input, output, total_tokens, cost) 합산.
    // total_tokens = input + output + cache_read + cache_write (대시보드 sumIO와 동일).
    use std::collections::HashMap;
    let mut acc: HashMap<(String, String), (i64, i64, i64, f64)> = HashMap::new();
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, Option<f64>>(6)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    for r in rows.flatten() {
        let (ts, source, inp, out, cr, cw, cost) = r;
        if let Some(date) = local_date_string(ts) {
            let entry = acc.entry((date, source)).or_insert((0, 0, 0, 0.0));
            let i = inp.unwrap_or(0);
            let o = out.unwrap_or(0);
            let cre = cr.unwrap_or(0);
            let cwr = cw.unwrap_or(0);
            entry.0 += i;
            entry.1 += o;
            entry.2 += i + o + cre + cwr;
            entry.3 += cost.unwrap_or(0.0);
        }
    }

    Ok(acc
        .into_iter()
        .map(|((date, source), (inp, out, total, cost))| UsageAggregate {
            user_id: user_id.to_string(),
            device_id: device_id.to_string(),
            date,
            source,
            total_input: inp,
            total_output: out,
            total_tokens: total,
            total_cost_usd: cost,
        })
        .collect())
}

fn read_tool_calls(
    user_id: &str,
    device_id: &str,
) -> Result<(Vec<McpUsageRow>, Vec<PluginUsageRow>), String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT ts, mcp_server, plugin_id FROM tool_calls")
        .map_err(|e| e.to_string())?;

    use std::collections::HashMap;
    let mut mcp: HashMap<(String, String), i64> = HashMap::new();
    let mut plugin: HashMap<(String, String), i64> = HashMap::new();

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    for r in rows.flatten() {
        let (ts, mcp_server, plugin_id) = r;
        let Some(date) = local_date_string(ts) else { continue };
        if let Some(server) = mcp_server {
            *mcp.entry((date.clone(), server)).or_insert(0) += 1;
        }
        if let Some(p) = plugin_id {
            *plugin.entry((date, p)).or_insert(0) += 1;
        }
    }

    let mcp_rows = mcp
        .into_iter()
        .map(|((date, mcp_server), count)| McpUsageRow {
            user_id: user_id.to_string(),
            device_id: device_id.to_string(),
            date,
            mcp_server,
            count,
        })
        .collect();
    let plugin_rows = plugin
        .into_iter()
        .map(|((date, plugin_id), count)| PluginUsageRow {
            user_id: user_id.to_string(),
            device_id: device_id.to_string(),
            date,
            plugin_id,
            count,
        })
        .collect();
    Ok((mcp_rows, plugin_rows))
}

/// usage_events 를 UTC 정시 버킷으로 합산해 usage_hourly 행 생성.
/// 최근 30일만 — 시간별 뷰는 최근만 의미 있고, 전체 기간이면 row 수가 폭증한다
/// (daily 의 24배). 일별 합계(read_usage_aggregates)는 전체 기간 그대로 올린다.
fn read_usage_hourly(user_id: &str, device_id: &str) -> Result<Vec<HourlyRow>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    // cutoff 를 정시(hour) 경계로 절삭 — 경계를 걸치는 시간 버킷이 cutoff 이후
    // 이벤트만으로 부분합돼 기존의 올바른 전체합을 덮어쓰는 undercount 를 방지.
    let raw_cutoff = Utc::now().timestamp_millis() - 30 * 86_400_000;
    let cutoff_ms = raw_cutoff - raw_cutoff.rem_euclid(3_600_000);
    let mut stmt = conn
        .prepare(
            "SELECT ts, source, model, input_tokens, output_tokens,
                    cache_read, cache_write, cost_usd
             FROM usage_events WHERE ts >= ?1",
        )
        .map_err(|e| e.to_string())?;

    use std::collections::HashMap;
    // (hour_utc, source, model) → (input, output, cache_read, cache_write, cost, count)
    let mut acc: HashMap<(String, String, String), (i64, i64, i64, i64, f64, i64)> = HashMap::new();
    let rows = stmt
        .query_map([cutoff_ms], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, Option<f64>>(7)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    for r in rows.flatten() {
        let (ts, source, model, inp, out, cr, cw, cost) = r;
        let Some(hour) = utc_hour_string(ts) else { continue };
        let entry = acc
            .entry((hour, source, model.unwrap_or_default()))
            .or_insert((0, 0, 0, 0, 0.0, 0));
        entry.0 += inp.unwrap_or(0);
        entry.1 += out.unwrap_or(0);
        entry.2 += cr.unwrap_or(0);
        entry.3 += cw.unwrap_or(0);
        entry.4 += cost.unwrap_or(0.0);
        entry.5 += 1;
    }

    Ok(acc
        .into_iter()
        .map(
            |((hour_utc, source, model), (inp, out, cr, cw, cost, count))| HourlyRow {
                user_id: user_id.to_string(),
                device_id: device_id.to_string(),
                hour_utc,
                source,
                model,
                input_tokens: inp,
                output_tokens: out,
                cache_read: cr,
                cache_write: cw,
                cost_usd: cost,
                request_count: count,
            },
        )
        .collect())
}

/// tool_calls 의 tool_name 을 (date, tool_name) 별로 카운트.
fn read_tool_usage(user_id: &str, device_id: &str) -> Result<Vec<ToolUsageRow>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT ts, tool_name FROM tool_calls
             WHERE tool_name IS NOT NULL AND tool_name <> ''",
        )
        .map_err(|e| e.to_string())?;

    use std::collections::HashMap;
    let mut acc: HashMap<(String, String), i64> = HashMap::new();
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    for r in rows.flatten() {
        let (ts, tool_name) = r;
        if let Some(date) = local_date_string(ts) {
            *acc.entry((date, tool_name)).or_insert(0) += 1;
        }
    }

    Ok(acc
        .into_iter()
        .map(|((date, tool_name), count)| ToolUsageRow {
            user_id: user_id.to_string(),
            device_id: device_id.to_string(),
            date,
            tool_name,
            count,
        })
        .collect())
}

/// 워터마크 이후 추가된 usage_events 가 건드린 (date,source) / (hour_utc,source,model) 버킷 수집.
/// 키 포맷이 read_usage_aggregates / read_usage_hourly 가 만드는 row 키와 정확히 일치해야
/// 하므로 같은 변환 함수(local_date_string / utc_hour_string)를 재사용한다 — SQLite 의
/// date(...,'localtime') 로 만들면 tz 처리 차이로 경계가 어긋날 수 있다.
fn collect_dirty_usage(
    conn: &rusqlite::Connection,
    wm: i64,
) -> Result<(HashSet<(String, String)>, HashSet<(String, String, String)>), String> {
    let mut stmt = conn
        .prepare("SELECT ts, source, COALESCE(model,'') FROM usage_events WHERE id > ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([wm], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut daily = HashSet::new();
    let mut hourly = HashSet::new();
    for r in rows.flatten() {
        let (ts, source, model) = r;
        if let Some(date) = local_date_string(ts) {
            daily.insert((date, source.clone()));
        }
        if let Some(hour) = utc_hour_string(ts) {
            hourly.insert((hour, source, model));
        }
    }
    Ok((daily, hourly))
}

/// 워터마크 이후 추가된 tool_calls 가 건드린 mcp/plugin/tool 일별 버킷 수집.
/// tool_name 빈 문자열 제외 — read_tool_usage 의 WHERE 조건과 동일.
fn collect_dirty_tool(
    conn: &rusqlite::Connection,
    wm: i64,
) -> Result<
    (
        HashSet<(String, String)>,
        HashSet<(String, String)>,
        HashSet<(String, String)>,
    ),
    String,
> {
    let mut stmt = conn
        .prepare("SELECT ts, mcp_server, plugin_id, tool_name FROM tool_calls WHERE id > ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([wm], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut mcp = HashSet::new();
    let mut plugin = HashSet::new();
    let mut tool = HashSet::new();
    for r in rows.flatten() {
        let (ts, mcp_server, plugin_id, tool_name) = r;
        let Some(date) = local_date_string(ts) else { continue };
        if let Some(s) = mcp_server {
            mcp.insert((date.clone(), s));
        }
        if let Some(p) = plugin_id {
            plugin.insert((date.clone(), p));
        }
        if let Some(t) = tool_name {
            if !t.is_empty() {
                tool.insert((date, t));
            }
        }
    }
    Ok((mcp, plugin, tool))
}

/// dirty 키에 속한 row 만 남기는 증분 sync 필터.
/// dirty=None(최초 sync / recalc 로 워터마크 리셋)이면 전체 유지 = 백필.
/// 집계는 항상 전체 이벤트 기준으로 다시 계산되므로(read_* 함수 미수정),
/// 여기서 걸러진 row 는 "마지막 sync 이후 값이 변하지 않은 버킷"이라 업로드 생략이 안전하다.
fn retain_dirty<T, K: Eq + Hash>(
    rows: Vec<T>,
    dirty: Option<&HashSet<K>>,
    key_of: impl Fn(&T) -> K,
) -> Vec<T> {
    match dirty {
        None => rows,
        Some(set) => rows
            .into_iter()
            .filter(|r| set.contains(&key_of(r)))
            .collect(),
    }
}

fn upsert<T: Serialize>(
    supabase_url: &str,
    publishable_key: &str,
    access_token: &str,
    table: &str,
    rows: &[T],
    on_conflict: &str,
) -> Result<usize, String> {
    if rows.is_empty() {
        return Ok(0);
    }
    let url = format!(
        "{}/rest/v1/{}?on_conflict={}",
        supabase_url, table, on_conflict
    );
    let body = serde_json::to_value(rows).map_err(|e| format!("serialize: {e}"))?;
    // PostgREST upsert: resolution=merge-duplicates → INSERT on conflict UPDATE.
    // return=minimal로 본문 응답 생략(트래픽↓), missing=default로 누락 컬럼은 기본값 사용.
    let resp = ureq::post(&url)
        .set("apikey", publishable_key)
        .set("Authorization", &format!("Bearer {}", access_token))
        .set("Content-Type", "application/json")
        .set(
            "Prefer",
            "resolution=merge-duplicates,return=minimal,missing=default",
        )
        // read timeout — 무설정 시 half-open TCP 에서 영구 블록 (백필은 페이로드가 커 여유 있게).
        .timeout(Duration::from_secs(30))
        .send_json(body);
    match resp {
        Ok(_) => Ok(rows.len()),
        Err(ureq::Error::Status(code, response)) => {
            let body = response.into_string().unwrap_or_default();
            Err(format!("HTTP {code} on {table}: {body}"))
        }
        Err(ureq::Error::Transport(e)) => Err(format!("Transport on {table}: {e}")),
    }
}

#[derive(Debug, Serialize)]
pub struct SyncResult {
    pub usage_rows: usize,
    pub mcp_rows: usize,
    pub plugin_rows: usize,
    pub hourly_rows: usize,
    pub tool_rows: usize,
}

/// Tauri command: 즉시 집계 동기화.
/// 호출자(frontend)가 share_consent=true인지 확인 후, 본인의 supabase access_token과
/// user_id를 함께 전달해야 한다. RLS WITH CHECK가 user_id = auth.uid()로 강제하므로
/// 다른 사람 데이터로 사칭할 수 없다.
/// 세션 메모리 캐시는 여기서 갱신하지 않는다 — set_supabase_session(검증 포함)이
/// 유일한 등록 경로. 여기서 store 하면 검증 우회 + 로그아웃 clear 와의 경합이 생긴다.
/// force=true 면 워터마크를 무시하고 전체 백필 — 원격 드리프트(수동 정정/복원) 복구용.
#[tauri::command]
pub async fn sync_aggregates_now(
    supabase_url: String,
    publishable_key: String,
    access_token: String,
    user_id: String,
    force: Option<bool>,
) -> Result<SyncResult, String> {
    let force = force.unwrap_or(false);
    let device_id = crate::commands::get_or_create_device_id()?;

    // ── 증분 sync 준비 ──────────────────────────────────────────────────────
    // 현재 MAX(id) + 마지막 sync 워터마크를 읽고, 변경분이 건드린 버킷(dirty)만 수집.
    // 워터마크 None = 최초 sync 또는 recalc 리셋 → 필터 없이 전체 업로드(백필).
    let (cur_max_usage, cur_max_tool, gen_before, dirty_daily, dirty_hourly, dirty_mcp, dirty_plugin, dirty_tool) = {
        let conn = db::open().map_err(|e| e.to_string())?;
        let cur_max_usage: i64 = conn
            .query_row("SELECT COALESCE(MAX(id),0) FROM usage_events", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let cur_max_tool: i64 = conn
            .query_row("SELECT COALESCE(MAX(id),0) FROM tool_calls", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        // 워터마크는 "이 로컬 DB 가 어떤 user_id 명의로 어디까지 업로드됐나" — 계정이
        // 바뀌면 새 계정 명의의 전체 백필이 필요하므로 무시한다 (force 도 동일 효과).
        let same_user = db::get_sync_state(&conn, db::SYNC_LAST_USER)
            .map(|u| u == user_id)
            .unwrap_or(false);
        let use_watermarks = same_user && !force;
        let wm_usage = if use_watermarks {
            db::get_sync_state(&conn, db::SYNC_WM_USAGE).and_then(|v| v.parse::<i64>().ok())
        } else {
            None
        };
        let wm_tool = if use_watermarks {
            db::get_sync_state(&conn, db::SYNC_WM_TOOL).and_then(|v| v.parse::<i64>().ok())
        } else {
            None
        };
        // sync 도중 cost 소급 보정(recalc)이 끼어들었는지 종료 시점에 비교할 세대 스냅샷.
        let gen_before = db::get_sync_state(&conn, db::SYNC_RECALC_GEN);

        // skip-if-clean: 마지막 sync 이후 새 이벤트가 없으면 네트워크 요청 자체를 생략.
        if let (Some(wu), Some(wt)) = (wm_usage, wm_tool) {
            if cur_max_usage <= wu && cur_max_tool <= wt {
                return Ok(SyncResult {
                    usage_rows: 0,
                    mcp_rows: 0,
                    plugin_rows: 0,
                    hourly_rows: 0,
                    tool_rows: 0,
                });
            }
        }

        let (dirty_daily, dirty_hourly) = match wm_usage {
            Some(wm) => {
                let (d, h) = collect_dirty_usage(&conn, wm)?;
                (Some(d), Some(h))
            }
            None => (None, None),
        };
        let (dirty_mcp, dirty_plugin, dirty_tool) = match wm_tool {
            Some(wm) => {
                let (m, p, t) = collect_dirty_tool(&conn, wm)?;
                (Some(m), Some(p), Some(t))
            }
            None => (None, None, None),
        };
        (cur_max_usage, cur_max_tool, gen_before, dirty_daily, dirty_hourly, dirty_mcp, dirty_plugin, dirty_tool)
    };

    // 집계는 기존대로 전체 이벤트 기준 — 업로드 직전에 dirty 버킷만 retain.
    let usage = retain_dirty(
        read_usage_aggregates(&user_id, &device_id)?,
        dirty_daily.as_ref(),
        |r| (r.date.clone(), r.source.clone()),
    );
    let (mcp, plugins) = read_tool_calls(&user_id, &device_id)?;
    let mcp = retain_dirty(mcp, dirty_mcp.as_ref(), |r| (r.date.clone(), r.mcp_server.clone()));
    let plugins = retain_dirty(plugins, dirty_plugin.as_ref(), |r| {
        (r.date.clone(), r.plugin_id.clone())
    });
    let hourly = retain_dirty(read_usage_hourly(&user_id, &device_id)?, dirty_hourly.as_ref(), |r| {
        (r.hour_utc.clone(), r.source.clone(), r.model.clone())
    });
    let tools = retain_dirty(read_tool_usage(&user_id, &device_id)?, dirty_tool.as_ref(), |r| {
        (r.date.clone(), r.tool_name.clone())
    });

    let usage_n = upsert(
        &supabase_url,
        &publishable_key,
        &access_token,
        "usage_aggregates",
        &usage,
        "user_id,date,source,device_id",
    )?;
    let mcp_n = upsert(
        &supabase_url,
        &publishable_key,
        &access_token,
        "mcp_usage",
        &mcp,
        "user_id,date,mcp_server,device_id",
    )?;
    let plugin_n = upsert(
        &supabase_url,
        &publishable_key,
        &access_token,
        "plugin_usage",
        &plugins,
        "user_id,date,plugin_id,device_id",
    )?;
    let hourly_n = upsert(
        &supabase_url,
        &publishable_key,
        &access_token,
        "usage_hourly",
        &hourly,
        "user_id,hour_utc,source,model,device_id",
    )?;
    let tool_n = upsert(
        &supabase_url,
        &publishable_key,
        &access_token,
        "tool_usage",
        &tools,
        "user_id,date,tool_name,device_id",
    )?;

    // 워터마크 전진 — 5개 upsert 가 모두 성공한 뒤에만. 부분 실패 시 미전진 →
    // 다음 sync 가 같은 dirty 버킷을 재업로드한다 (upsert 멱등이라 안전).
    // 단, sync 도중 cost 소급 보정(recalc)이 끼어들어 세대가 변했다면 전진을 포기한다 —
    // 이번 업로드는 보정 전 값을 읽었을 수 있고, recalc 가 지운 워터마크를 여기서
    // 되살리면 보정값이 영원히 재업로드되지 않기 때문 (다음 sync 가 전체 백필).
    {
        let conn = db::open().map_err(|e| e.to_string())?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let gen_now = db::get_sync_state(&tx, db::SYNC_RECALC_GEN);
        if gen_now == gen_before {
            db::set_sync_state(&tx, db::SYNC_WM_USAGE, &cur_max_usage.to_string())
                .map_err(|e| e.to_string())?;
            db::set_sync_state(&tx, db::SYNC_WM_TOOL, &cur_max_tool.to_string())
                .map_err(|e| e.to_string())?;
            db::set_sync_state(&tx, db::SYNC_LAST_USER, &user_id)
                .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
        } else {
            eprintln!("[sync] cost recalc occurred mid-sync — watermark not advanced (next sync re-uploads)");
        }
    }

    // legacy 정리 — 5개 upsert 가 모두 성공한 뒤(업로드 실패 시 도달 안 함) 1회만.
    // 옛 device_id='legacy' 행은 신규 device_id 행으로 이관됐으므로 중복 합산을 막기 위해 삭제.
    // 로컬 one-time 플래그로 가드해 매 sync 마다 RPC 를 호출하지 않는다.
    if !crate::commands::read_bool_flag("device_migration_purged") {
        let purge_url = format!("{}/rest/v1/rpc/purge_my_legacy", supabase_url);
        let resp = ureq::post(&purge_url)
            .set("apikey", &publishable_key)
            .set("Authorization", &format!("Bearer {}", access_token))
            .set("Content-Type", "application/json")
            .timeout(Duration::from_secs(10))
            .send_json(serde_json::json!({}));
        if resp.is_ok() {
            let _ = crate::commands::set_bool_flag("device_migration_purged", true);
        }
    }

    Ok(SyncResult {
        usage_rows: usage_n,
        mcp_rows: mcp_n,
        plugin_rows: plugin_n,
        hourly_rows: hourly_n,
        tool_rows: tool_n,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // 다기기 합산: 내 device_id 행은 제외(표시 시점에 로컬 값으로 대체)하고
    // 타기기 행(비용 NULL 은 0)만 합산되는지.
    #[test]
    fn sum_other_devices_excludes_my_device() {
        let rows = vec![
            RemoteCostRow {
                device_id: "me".into(),
                total_cost_usd: Some(99.0), // 내 기기 — DB 값은 stale 일 수 있어 제외돼야 함
            },
            RemoteCostRow {
                device_id: "other-1".into(),
                total_cost_usd: Some(1.5),
            },
            RemoteCostRow {
                device_id: "other-2".into(),
                total_cost_usd: Some(2.0),
            },
            RemoteCostRow {
                device_id: "other-3".into(),
                total_cost_usd: None,
            },
        ];
        // 1.5 + 2.0 + 0.0 — "me" 의 99.0 은 미포함.
        let total = sum_other_devices_cost(&rows, "me");
        assert!((total - 3.5).abs() < 1e-9, "got {total}");

        // 타기기 행이 없으면 0.
        assert_eq!(sum_other_devices_cost(&[], "me"), 0.0);
    }

    // 증분 sync 핵심 필터: dirty 키에 속한 row 만 남고, None(최초/리셋)이면 전체 유지.
    #[test]
    fn retain_dirty_filters_only_dirty_buckets() {
        let rows = || {
            vec![
                ("2026-06-10".to_string(), "claude".to_string()),
                ("2026-06-10".to_string(), "codex".to_string()),
                ("2026-06-09".to_string(), "claude".to_string()),
            ]
        };
        let key_of = |r: &(String, String)| (r.0.clone(), r.1.clone());

        let mut dirty: HashSet<(String, String)> = HashSet::new();
        dirty.insert(("2026-06-10".to_string(), "claude".to_string()));

        let kept = retain_dirty(rows(), Some(&dirty), key_of);
        assert_eq!(kept, vec![("2026-06-10".to_string(), "claude".to_string())]);

        // dirty=None → 백필: 전체 유지.
        assert_eq!(retain_dirty(rows(), None, key_of).len(), 3);

        // dirty 가 빈 셋이면 업로드할 row 없음.
        let empty: HashSet<(String, String)> = HashSet::new();
        assert!(retain_dirty(rows(), Some(&empty), key_of).is_empty());
    }
}
