// 사내 집계 업로드 — 로컬 SQLite의 toks/cost/MCP/플러그인 카운트를 Supabase로 upsert.
// 원본 메시지/프롬프트는 절대 업로드하지 않는다. 카운트와 합계만.
//
// 전제조건: 호출자가 share_consent=true임을 확인한 뒤에만 호출.
// user_id는 호출자가 인증된 Supabase 세션의 auth.uid()를 넘김 — RLS WITH CHECK 통과용.

use chrono::{Local, TimeZone, Utc};
use serde::Serialize;

use crate::db;

/// 우리 Supabase usage_aggregates row 형태
/// total_tokens = input + output + cache_read + cache_write — 대시보드 sumIO와 동일.
#[derive(Debug, Serialize)]
struct UsageAggregate {
    user_id: String,
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
    date: String,
    mcp_server: String,
    count: i64,
}

#[derive(Debug, Serialize)]
struct PluginUsageRow {
    user_id: String,
    date: String,
    plugin_id: String,
    count: i64,
}

/// tool_usage row — tool_name 별 일별 호출 수.
#[derive(Debug, Serialize)]
struct ToolUsageRow {
    user_id: String,
    date: String,
    tool_name: String,
    count: i64,
}

/// usage_hourly row 형태 — UTC 정시(hour) 버킷. (user_id, hour_utc, source, model) PK.
#[derive(Debug, Serialize)]
struct HourlyRow {
    user_id: String,
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

fn read_usage_aggregates(user_id: &str) -> Result<Vec<UsageAggregate>, String> {
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
            date,
            source,
            total_input: inp,
            total_output: out,
            total_tokens: total,
            total_cost_usd: cost,
        })
        .collect())
}

fn read_tool_calls(user_id: &str) -> Result<(Vec<McpUsageRow>, Vec<PluginUsageRow>), String> {
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
            date,
            mcp_server,
            count,
        })
        .collect();
    let plugin_rows = plugin
        .into_iter()
        .map(|((date, plugin_id), count)| PluginUsageRow {
            user_id: user_id.to_string(),
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
fn read_usage_hourly(user_id: &str) -> Result<Vec<HourlyRow>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let cutoff_ms = Utc::now().timestamp_millis() - 30 * 86_400_000;
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
fn read_tool_usage(user_id: &str) -> Result<Vec<ToolUsageRow>, String> {
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
            date,
            tool_name,
            count,
        })
        .collect())
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
#[tauri::command]
pub async fn sync_aggregates_now(
    supabase_url: String,
    publishable_key: String,
    access_token: String,
    user_id: String,
) -> Result<SyncResult, String> {
    let usage = read_usage_aggregates(&user_id)?;
    let (mcp, plugins) = read_tool_calls(&user_id)?;
    let hourly = read_usage_hourly(&user_id)?;
    let tools = read_tool_usage(&user_id)?;

    let usage_n = upsert(
        &supabase_url,
        &publishable_key,
        &access_token,
        "usage_aggregates",
        &usage,
        "user_id,date,source",
    )?;
    let mcp_n = upsert(
        &supabase_url,
        &publishable_key,
        &access_token,
        "mcp_usage",
        &mcp,
        "user_id,date,mcp_server",
    )?;
    let plugin_n = upsert(
        &supabase_url,
        &publishable_key,
        &access_token,
        "plugin_usage",
        &plugins,
        "user_id,date,plugin_id",
    )?;
    let hourly_n = upsert(
        &supabase_url,
        &publishable_key,
        &access_token,
        "usage_hourly",
        &hourly,
        "user_id,hour_utc,source,model",
    )?;
    let tool_n = upsert(
        &supabase_url,
        &publishable_key,
        &access_token,
        "tool_usage",
        &tools,
        "user_id,date,tool_name",
    )?;

    Ok(SyncResult {
        usage_rows: usage_n,
        mcp_rows: mcp_n,
        plugin_rows: plugin_n,
        hourly_rows: hourly_n,
        tool_rows: tool_n,
    })
}
