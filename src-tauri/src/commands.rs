use rusqlite::params;
use serde_json::Value as JsonValue;
use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::db::{db_path, open, range_bounds};
use crate::models::{DayCount, McpUsage, PluginUsage, Point, ToolUsage};

/// 오늘(local-tz 자정 기준) USD 비용 합계. 트레이 타이틀 표시용.
pub fn today_cost_usd() -> f64 {
    let conn = match open() {
        Ok(c) => c,
        Err(_) => return 0.0,
    };
    let (start, end) = range_bounds("today");
    conn.query_row(
        "SELECT COALESCE(SUM(cost_usd), 0.0)
         FROM usage_events
         WHERE ts BETWEEN ?1 AND ?2",
        params![start, end],
        |row| row.get::<_, f64>(0),
    )
    .unwrap_or(0.0)
}

#[tauri::command]
pub fn get_today_cost_usd() -> Result<f64, String> {
    Ok(today_cost_usd())
}

// =============================================================================
// 앱 설정 — settings.json (data dir 안)
// =============================================================================

fn settings_path() -> Option<PathBuf> {
    db_path().parent().map(|p| p.join("settings.json"))
}

fn read_settings() -> BTreeMap<String, JsonValue> {
    let Some(path) = settings_path() else {
        return BTreeMap::new();
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return BTreeMap::new();
    };
    serde_json::from_str::<BTreeMap<String, JsonValue>>(&raw).unwrap_or_default()
}

fn write_settings(map: &BTreeMap<String, JsonValue>) -> Result<(), String> {
    let path = settings_path().ok_or_else(|| "settings 경로를 찾을 수 없습니다".to_string())?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let raw = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw).map_err(|e| e.to_string())
}

// =============================================================================
// 기기 식별자 — device.json (config dir 안)
// =============================================================================

/// 기기별 device_id 파일 경로 — `config_dir()/madup-token-monitor/device.json`.
/// 의도적으로 db_path()(data_dir) 가 아니라 config_dir 에 둔다: delete_all_data 가
/// data_files() 만 지우므로 기기 정체성은 데이터 삭제와 분리되어 보존된다.
fn device_id_path() -> Option<PathBuf> {
    dirs::config_dir().map(|p| p.join("madup-token-monitor").join("device.json"))
}

/// 기기별 고유 device_id 를 1회 생성·영속해 반환.
/// 파일이 있으면 읽고, 없으면 uuidv4 를 생성해 저장한다.
/// 다기기 사용 시 집계가 기기별 행으로 분리 보존되도록 하는 키.
pub fn get_or_create_device_id() -> Result<String, String> {
    let path = device_id_path().ok_or_else(|| "device 경로를 찾을 수 없습니다".to_string())?;

    if let Ok(raw) = std::fs::read_to_string(&path) {
        if let Ok(map) = serde_json::from_str::<BTreeMap<String, JsonValue>>(&raw) {
            if let Some(JsonValue::String(id)) = map.get("device_id") {
                if !id.is_empty() {
                    return Ok(id.clone());
                }
            }
        }
    }

    let id = uuid::Uuid::new_v4().to_string();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut map: BTreeMap<String, JsonValue> = BTreeMap::new();
    map.insert("device_id".to_string(), JsonValue::String(id.clone()));
    let raw = serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw).map_err(|e| e.to_string())?;
    Ok(id)
}

/// settings.json 의 boolean 플래그 1개 조회 (없으면 false). 일회성 마이그레이션 가드용.
pub fn read_bool_flag(key: &str) -> bool {
    matches!(read_settings().get(key), Some(JsonValue::Bool(true)))
}

/// settings.json 의 boolean 플래그 1개 set. 일회성 마이그레이션 완료 표시용.
pub fn set_bool_flag(key: &str, value: bool) -> Result<(), String> {
    let mut map = read_settings();
    map.insert(key.to_string(), JsonValue::Bool(value));
    write_settings(&map)
}

/// `show_menubar_cost` 가 `false` 일 때 false 반환. 기본값은 true.
pub fn read_show_menubar_cost() -> bool {
    let map = read_settings();
    match map.get("show_menubar_cost") {
        Some(JsonValue::Bool(b)) => *b,
        _ => true,
    }
}

#[tauri::command]
pub fn get_settings() -> Result<JsonValue, String> {
    let map = read_settings();
    Ok(serde_json::to_value(map).unwrap_or(JsonValue::Null))
}

#[tauri::command]
pub fn set_setting(app: tauri::AppHandle, key: String, value: JsonValue) -> Result<(), String> {
    let touched_menubar = key == "show_menubar_cost";
    let mut map = read_settings();
    map.insert(key, value);
    write_settings(&map)?;
    // 토글 즉시 반영 — 트레이 타이틀을 바로 갱신(60초 폴링 지연 제거).
    if touched_menubar {
        crate::tray::refresh_tray_title(&app);
    }
    Ok(())
}

/// React Query 영속 캐시 등 클라이언트 캐시는 JS 측에서 비우고,
/// 여기서는 SQLite WAL 을 checkpoint(TRUNCATE) 로 안전하게 회수한다.
/// (열린 DB 의 -wal/-shm 을 직접 remove 하면 in-flight write 손상 위험 → 파일 삭제 대신 체크포인트)
#[tauri::command]
pub fn clear_cache_dir() -> Result<u64, String> {
    let db = db_path();
    let Some(parent) = db.parent() else {
        return Err("데이터 디렉토리를 찾을 수 없습니다".into());
    };
    let db_name = db.file_name().and_then(|s| s.to_str()).unwrap_or("data.db");
    // 회수 전 WAL 크기 (리포트용). 실제 파일명은 <db>-wal (예: data.db-wal).
    let freed = std::fs::metadata(parent.join(format!("{db_name}-wal")))
        .map(|m| m.len())
        .unwrap_or(0);
    if let Ok(conn) = open() {
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }
    Ok(freed)
}

/// delete_all_data 가 지울 파일 목록 — db_path() 기준 파생 (db + wal/shm + settings.json).
/// 파일명을 하드코딩하지 않는다: 과거 'usage.sqlite' 로 하드코딩돼 실제 'data.db' 를 못 지운 버그가 있었음.
fn data_files(db: &std::path::Path) -> Vec<PathBuf> {
    let Some(parent) = db.parent() else {
        return Vec::new();
    };
    let name = db.file_name().and_then(|s| s.to_str()).unwrap_or("data.db");
    vec![
        parent.join(name),
        parent.join(format!("{name}-wal")),
        parent.join(format!("{name}-shm")),
        parent.join("settings.json"),
    ]
}

/// 모든 로컬 데이터 (SQLite db + WAL/SHM + settings.json) 삭제.
/// 호출 후 앱을 재시작해야 새 SQLite 가 다시 만들어지고 JSONL 이 전량 재파싱된다.
#[tauri::command]
pub fn delete_all_data() -> Result<(), String> {
    let files = data_files(&db_path());
    if files.is_empty() {
        return Err("데이터 디렉토리를 찾을 수 없습니다".into());
    }
    for p in files {
        let _ = std::fs::remove_file(&p);
    }
    Ok(())
}

#[tauri::command]
pub fn get_timeseries(range: String, source: Option<String>) -> Result<Vec<Point>, String> {
    let conn = open().map_err(|e| e.to_string())?;
    let (start, end) = range_bounds(&range);

    // Bucket by hour
    let sql = if source.is_some() {
        "SELECT (ts / 3600000) * 3600000 as bucket,
                COALESCE(SUM(input_tokens),0),
                COALESCE(SUM(output_tokens),0),
                COALESCE(SUM(cache_read),0),
                COALESCE(SUM(cache_write),0),
                COALESCE(SUM(cost_usd),0.0)
         FROM usage_events
         WHERE ts BETWEEN ?1 AND ?2 AND source = ?3
         GROUP BY bucket ORDER BY bucket"
    } else {
        "SELECT (ts / 3600000) * 3600000 as bucket,
                COALESCE(SUM(input_tokens),0),
                COALESCE(SUM(output_tokens),0),
                COALESCE(SUM(cache_read),0),
                COALESCE(SUM(cache_write),0),
                COALESCE(SUM(cost_usd),0.0)
         FROM usage_events
         WHERE ts BETWEEN ?1 AND ?2
         GROUP BY bucket ORDER BY bucket"
    };

    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;

    let map_row = |row: &rusqlite::Row| {
        Ok(Point {
            ts: row.get(0)?,
            input_tokens: row.get(1)?,
            output_tokens: row.get(2)?,
            cache_read: row.get(3)?,
            cache_write: row.get(4)?,
            cost_usd: row.get(5)?,
        })
    };

    let points: Vec<Point> = if let Some(src) = source {
        stmt.query_map(params![start, end, src], map_row)
    } else {
        stmt.query_map(params![start, end], map_row)
    }
    .map_err(|e| e.to_string())?
    .flatten()
    .collect();

    Ok(points)
}

#[tauri::command]
pub fn get_top_mcp(range: String) -> Result<Vec<McpUsage>, String> {
    let conn = open().map_err(|e| e.to_string())?;
    let (start, end) = range_bounds(&range);

    let mut stmt = conn
        .prepare(
            "SELECT mcp_server, COUNT(*) as cnt
             FROM tool_calls
             WHERE ts BETWEEN ?1 AND ?2 AND mcp_server IS NOT NULL
             GROUP BY mcp_server
             ORDER BY cnt DESC
             LIMIT 10",
        )
        .map_err(|e| e.to_string())?;

    let items = stmt
        .query_map(params![start, end], |row| {
            Ok(McpUsage {
                mcp_server: row.get(0)?,
                count: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();

    Ok(items)
}

#[tauri::command]
pub fn get_top_plugins(range: String) -> Result<Vec<PluginUsage>, String> {
    let conn = open().map_err(|e| e.to_string())?;
    let (start, end) = range_bounds(&range);

    let mut stmt = conn
        .prepare(
            "SELECT plugin_id, COUNT(*) as cnt
             FROM tool_calls
             WHERE ts BETWEEN ?1 AND ?2 AND plugin_id IS NOT NULL
             GROUP BY plugin_id
             ORDER BY cnt DESC
             LIMIT 10",
        )
        .map_err(|e| e.to_string())?;

    let items = stmt
        .query_map(params![start, end], |row| {
            Ok(PluginUsage {
                plugin_id: row.get(0)?,
                count: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();

    Ok(items)
}

/// 도구(tool_name) 별 호출 TOP — "주 사용 tools" 관찰용.
#[tauri::command]
pub fn get_top_tools(range: String) -> Result<Vec<ToolUsage>, String> {
    let conn = open().map_err(|e| e.to_string())?;
    let (start, end) = range_bounds(&range);

    let mut stmt = conn
        .prepare(
            "SELECT tool_name, COUNT(*) as cnt
             FROM tool_calls
             WHERE ts BETWEEN ?1 AND ?2 AND tool_name IS NOT NULL AND tool_name <> ''
             GROUP BY tool_name
             ORDER BY cnt DESC
             LIMIT 10",
        )
        .map_err(|e| e.to_string())?;

    let items = stmt
        .query_map(params![start, end], |row| {
            Ok(ToolUsage {
                tool_name: row.get(0)?,
                count: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();

    Ok(items)
}

#[tauri::command]
pub fn get_heatmap(days: Option<i64>, source: Option<String>) -> Result<Vec<DayCount>, String> {
    let conn = open().map_err(|e| e.to_string())?;
    let n = days.unwrap_or(30);
    let now = chrono::Utc::now().timestamp_millis();
    let start = now - n * 86_400_000;

    let mut stmt = conn
        .prepare(
            "SELECT date(ts / 1000, 'unixepoch', '+9 hours') as day,
                    COUNT(*) as cnt,
                    COALESCE(SUM(cost_usd), 0.0)
             FROM usage_events
             WHERE ts >= ?1 AND (?2 IS NULL OR source = ?2)
             GROUP BY day
             ORDER BY day",
        )
        .map_err(|e| e.to_string())?;

    let items = stmt
        .query_map(params![start, source], |row| {
            Ok(DayCount {
                date: row.get(0)?,
                count: row.get(1)?,
                cost_usd: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();

    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    // 회귀: delete_all_data 가 지울 파일이 db_path() 기준으로 파생되는지 (옛 'usage.sqlite' 하드코딩 금지).
    #[test]
    fn data_files_derive_from_db_path() {
        let files = data_files(Path::new("/x/y/data.db"));
        let names: Vec<String> = files
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            vec![
                "/x/y/data.db".to_string(),
                "/x/y/data.db-wal".to_string(),
                "/x/y/data.db-shm".to_string(),
                "/x/y/settings.json".to_string(),
            ]
        );
        // 실제 DB 파일(data.db)이 삭제 대상에 포함돼야 한다.
        assert!(names.iter().any(|n| n.ends_with("/data.db")));
        // 옛 잘못된 이름이 남아있지 않아야 한다.
        assert!(!names.iter().any(|n| n.contains("usage.sqlite")));
    }
}
