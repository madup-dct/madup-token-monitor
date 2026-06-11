use rusqlite::{Connection, Result, params};
use std::path::PathBuf;
use crate::models::{UsageEvent, ToolCall};

pub fn db_path() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("madup-token-monitor").join("data.db")
}

pub fn open() -> Result<Connection> {
    let path = db_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let conn = Connection::open(&path)?;
    // busy_timeout — watcher INSERT burst 와 sync/트레이 폴링의 동시 open 에서
    // SQLITE_BUSY 즉시 실패 대신 대기. 증분 sync 의 워터마크 트랜잭션 보호.
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;",
    )?;
    // migrate 는 프로세스당 1회 — DDL/일회성 청소/recalc 가 매 open 마다 풀스캔 도는
    // 비용 제거 (sync 1회당 open 6회 실측). 단가표·플러그인 레지스트리는 앱 시작 시점
    // 고정(OnceLock)이라 런타임 재실행의 의미도 없다.
    static MIGRATED: std::sync::Mutex<bool> = std::sync::Mutex::new(false);
    {
        let mut done = MIGRATED.lock().unwrap_or_else(|e| e.into_inner());
        if !*done {
            migrate(&conn)?;
            *done = true;
        }
    }
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS usage_events (
            id              INTEGER PRIMARY KEY,
            source          TEXT NOT NULL,
            model           TEXT,
            ts              INTEGER NOT NULL,
            input_tokens    INTEGER,
            output_tokens   INTEGER,
            cache_read      INTEGER,
            cache_write     INTEGER,
            cache_write_5m  INTEGER,
            cache_write_1h  INTEGER,
            cost_usd        REAL,
            project         TEXT,
            session_id      TEXT,
            message_id      TEXT,
            request_id      TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts);
        -- ai-token-monitor와 동일한 dedup key. 같은 응답이 여러 jsonl에 미러되어도
        -- (message_id, request_id) 조합으로 한 번만 카운트.
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_usage_msg
            ON usage_events(message_id, request_id);

        CREATE TABLE IF NOT EXISTS tool_calls (
            id        INTEGER PRIMARY KEY,
            source    TEXT,
            ts        INTEGER,
            tool_name TEXT,
            mcp_server TEXT,
            plugin_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_tool_ts ON tool_calls(ts);
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_tool_call
            ON tool_calls(source, ts, tool_name);

        CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    )?;

    // 기존 DB의 누락된 컬럼 추가 (idempotent)
    let _ = conn.execute("ALTER TABLE usage_events ADD COLUMN message_id TEXT", []);
    let _ = conn.execute("ALTER TABLE usage_events ADD COLUMN request_id TEXT", []);
    let _ = conn.execute("ALTER TABLE usage_events ADD COLUMN cache_write_5m INTEGER", []);
    let _ = conn.execute("ALTER TABLE usage_events ADD COLUMN cache_write_1h INTEGER", []);

    // 옛 (source, session_id, ts, model, tokens) UNIQUE INDEX는 약해서 중복 허용 — 제거
    let _ = conn.execute("DROP INDEX IF EXISTS uniq_usage_event", []);
    // 일회성 partial index 시도 흔적 제거 (있으면)
    let _ = conn.execute("DROP INDEX IF EXISTS uniq_usage_msg_id", []);

    // ── 일회성 plugin_id 청소 ───────────────────────────────────────────────
    // 옛 휴리스틱: 하이픈 있는 mcp_server를 그대로 plugin_id로 복사 (mcp-atlassian, slack-bot,
    // plugin_oh-my-claudecode_t 등 → 모두 plugin으로 잘못 카운트). 새 파서는 plugin_<name>_t
    // 형식만 plugin_id로 인정. 옛 row 정리:
    //   1) plugin_id == mcp_server 인 row → plugin_id NULL (대부분 일반 MCP 서버였음)
    //   2) mcp_server 가 plugin_<name>_t 형식이면 <name> 만 추출해서 plugin_id에 재기입
    // 재분류 row 수를 누적 — 0건이 아니면 tool 워터마크를 리셋해 증분 sync 가
    // in-place 변경(id 불변이라 dirty 로 안 잡힘)을 Supabase 에 반영하게 한다.
    let mut reclassified = 0usize;
    reclassified += conn
        .execute(
            "UPDATE tool_calls SET plugin_id = NULL
         WHERE plugin_id IS NOT NULL AND plugin_id = mcp_server",
            [],
        )
        .unwrap_or(0);
    // SQLite SUBSTR(s, start, length) — 1-indexed. 'plugin_'(7) 다음 시작, 끝 '_t'(2) 제거.
    reclassified += conn
        .execute(
            "UPDATE tool_calls
         SET plugin_id = SUBSTR(mcp_server, 8, LENGTH(mcp_server) - 9)
         WHERE mcp_server LIKE 'plugin_%_t'
           AND LENGTH(mcp_server) > 9",
            [],
        )
        .unwrap_or(0);
    // Claude Code 플러그인은 MCP TOP에 보이지 않게 mcp_server NULL로 정리.
    reclassified += conn
        .execute(
            "UPDATE tool_calls
         SET mcp_server = NULL
         WHERE mcp_server LIKE 'plugin_%_t'",
            [],
        )
        .unwrap_or(0);
    // 플러그인 레지스트리(~/.claude/plugins/cache 폴더명) 기준으로 옛 분류 보정 —
    // 설치된 플러그인 ID와 일치하는 mcp_server 는 plugin_id 로 이동.
    for plugin_id in crate::plugins::known_plugin_ids() {
        reclassified += conn
            .execute(
                "UPDATE tool_calls
             SET plugin_id = ?1, mcp_server = NULL
             WHERE mcp_server = ?1",
                params![plugin_id],
            )
            .unwrap_or(0);
    }
    if reclassified > 0 {
        // recalc 와 같은 패턴: 워터마크 삭제 + 세대 증가 (sync 도중이면 전진 포기 유도).
        let _ = conn.execute(
            "DELETE FROM sync_state WHERE key = ?1",
            params![SYNC_WM_TOOL],
        );
        let _ = conn.execute(
            "INSERT INTO sync_state (key, value) VALUES (?1, '1')
             ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1",
            params![SYNC_RECALC_GEN],
        );
    }

    // ── cost=0 이벤트 재계산 ────────────────────────────────────────────────
    // 단가표에 없던 신규 모델(예: claude-fable-5)이 cost_usd=0 으로 적재된 이벤트를
    // 현재 단가표로 보정. 단가가 여전히 없는 모델(<synthetic> 등)은 0 유지라 idempotent.
    //
    // 보정(UPDATE) + 워터마크 삭제 + 세대 증가를 한 트랜잭션으로 묶는다 —
    // "보정은 됐는데 재업로드 강제는 누락" 되는 부분 실패를 차단하고,
    // 실패 시 전체 롤백돼 다음 open 의 recalc 가 처음부터 재시도한다 (자가복구).
    if let Ok(tx) = conn.unchecked_transaction() {
        match recalc_zero_cost_events(&tx) {
            Ok(fixed) if fixed > 0 => {
                // cost 소급 보정은 기존 usage_events row(id ≤ 워터마크)를 바꾸므로
                // usage 워터마크만 삭제해 1회 전체 재업로드를 강제한다
                // (tool_calls 집계는 cost 와 무관 — TOOL 워터마크는 유지).
                // 세대 카운터는 "sync 진행 중에 보정이 끼어든" 경우 sync 종료부가
                // 워터마크 전진을 포기하게 하는 신호 (aggregator 참조).
                let reset = tx
                    .execute("DELETE FROM sync_state WHERE key = ?1", params![SYNC_WM_USAGE])
                    .and_then(|_| {
                        tx.execute(
                            "INSERT INTO sync_state (key, value) VALUES (?1, '1')
                             ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1",
                            params![SYNC_RECALC_GEN],
                        )
                    });
                match reset {
                    Ok(_) => {
                        let _ = tx.commit();
                    }
                    Err(e) => eprintln!("[recalc] watermark reset failed (rolled back): {e}"),
                }
            }
            Ok(_) => {
                let _ = tx.commit();
            }
            Err(e) => eprintln!("[recalc] failed: {e}"),
        }
    }

    Ok(())
}

/// 증분 sync 워터마크 키 — aggregator 가 마지막 업로드 시점의 MAX(id) 를 기록.
pub const SYNC_WM_USAGE: &str = "last_synced_usage_event_id";
pub const SYNC_WM_TOOL: &str = "last_synced_tool_call_id";
/// 마지막으로 업로드한 user_id — 계정 전환 시 워터마크를 무시하고 새 계정 명의로
/// 전체 백필하기 위한 바인딩.
pub const SYNC_LAST_USER: &str = "last_synced_user_id";
/// cost 소급 보정 세대 — recalc 가 row 를 고칠 때마다 +1. sync 는 시작/종료 세대가
/// 다르면 워터마크를 전진시키지 않아, 보정 직후의 전체 재업로드 강제가 덮어써지지 않는다.
pub const SYNC_RECALC_GEN: &str = "recalc_generation";

pub fn get_sync_state(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM sync_state WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .ok()
}

pub fn set_sync_state(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO sync_state (key, value) VALUES (?1, ?2)",
        params![key, value],
    )?;
    Ok(())
}

/// cost_usd=0 으로 기록된 이벤트를 현재 단가표 기준으로 재계산.
/// 단가 매칭 실패로 0 이었던 모델이 이후 pricing.json 에 추가되면 여기서 소급 보정된다.
fn recalc_zero_cost_events(conn: &Connection) -> Result<usize> {
    let mut stmt = conn.prepare(
        "SELECT id, model, COALESCE(input_tokens,0), COALESCE(output_tokens,0),
                COALESCE(cache_read,0), COALESCE(cache_write,0),
                COALESCE(cache_write_5m,0), COALESCE(cache_write_1h,0)
         FROM usage_events
         WHERE (cost_usd = 0 OR cost_usd IS NULL) AND model IS NOT NULL AND model != ''",
    )?;
    let rows: Vec<(i64, String, i64, i64, i64, i64, i64, i64)> = stmt
        .query_map([], |r| {
            Ok((
                r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?,
                r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?,
            ))
        })?
        .flatten()
        .collect();

    let mut fixed = 0;
    for (id, model, inp, out, cr, cw, cw5, cw1) in rows {
        // 5m/1h 분리 컬럼이 비어 있는 옛 이벤트는 cache_write 전체를 5m(1.25x, 보수적)로 간주.
        let (cw5, cw1) = if cw5 == 0 && cw1 == 0 { (cw, 0) } else { (cw5, cw1) };
        let cost = crate::pricing::calc_cost_usd(&model, inp, out, cr, cw5, cw1);
        if cost > 0.0 {
            conn.execute(
                "UPDATE usage_events SET cost_usd = ?1 WHERE id = ?2",
                params![cost, id],
            )?;
            fixed += 1;
        }
    }
    Ok(fixed)
}

pub fn insert_usage_event(conn: &Connection, e: &UsageEvent) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO usage_events
            (source, model, ts, input_tokens, output_tokens, cache_read, cache_write, cache_write_5m, cache_write_1h, cost_usd, project, session_id, message_id, request_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        params![
            e.source, e.model, e.ts,
            e.input_tokens, e.output_tokens,
            e.cache_read, e.cache_write,
            e.cache_write_5m, e.cache_write_1h,
            e.cost_usd, e.project, e.session_id,
            e.message_id, e.request_id,
        ],
    )?;
    Ok(())
}

pub fn insert_tool_call(conn: &Connection, t: &ToolCall) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO tool_calls (source, ts, tool_name, mcp_server, plugin_id)
         VALUES (?1,?2,?3,?4,?5)",
        params![t.source, t.ts, t.tool_name, t.mcp_server, t.plugin_id],
    )?;
    Ok(())
}

/// Returns unix-ms range for the given range string.
/// 모든 range를 local-tz 자정 기준 + Postgres `current_date - interval 'N days'`와 일치하는
/// "오늘 자정 - N일" 시작점으로 통일. 사내 RPC와 동일 정의.
pub fn range_bounds(range: &str) -> (i64, i64) {
    use chrono::{Duration, Local, TimeZone};
    let now = chrono::Utc::now().timestamp_millis();
    let today_local = Local::now().date_naive();
    let midnight_ms = |d: chrono::NaiveDate| -> i64 {
        Local
            .from_local_datetime(&d.and_hms_opt(0, 0, 0).unwrap())
            .single()
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(now)
    };
    let start = match range {
        "today" | "1d" => midnight_ms(today_local),
        "7d" => midnight_ms(today_local - Duration::days(7)),
        "30d" => midnight_ms(today_local - Duration::days(30)),
        "90d" => midnight_ms(today_local - Duration::days(90)),
        "365d" => midnight_ms(today_local - Duration::days(365)),
        // weekly/monthly 그룹핑이 의미 있는 옵션 리스트 (월/년) 를 만들려면
        // SQLite 의 모든 기록을 모아야 함. local DB 라 양이 제한적.
        "all" => 0,
        _ => midnight_ms(today_local),
    };
    (start, now)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE usage_events (
                id INTEGER PRIMARY KEY, source TEXT NOT NULL, model TEXT, ts INTEGER NOT NULL,
                input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER, cache_write INTEGER,
                cache_write_5m INTEGER, cache_write_1h INTEGER, cost_usd REAL,
                project TEXT, session_id TEXT, message_id TEXT, request_id TEXT
            );",
        )
        .unwrap();
        conn
    }

    // 회귀: 단가표 누락으로 cost=0 적재된 fable 이벤트가 소급 보정되는지.
    #[test]
    fn test_recalc_zero_cost_events() {
        let conn = test_conn();
        conn.execute_batch(
            "INSERT INTO usage_events (source, model, ts, input_tokens, output_tokens, cache_read, cache_write, cache_write_5m, cache_write_1h, cost_usd)
             VALUES ('claude', 'claude-fable-5', 1, 1000000, 0, 0, 0, 0, 0, 0.0),
                    ('claude', '<synthetic>', 2, 1000000, 0, 0, 0, 0, 0, 0.0),
                    ('claude', 'claude-fable-5', 3, 0, 0, 0, 1000000, 0, 0, 0.0),
                    ('claude', 'claude-opus-4-8', 4, 1000000, 0, 0, 0, 0, 0, 5.0);",
        )
        .unwrap();

        let fixed = recalc_zero_cost_events(&conn).unwrap();
        assert_eq!(fixed, 2, "fable 2건만 보정 (<synthetic> 0 유지, 기존 cost>0 미변경)");

        let fable: f64 = conn
            .query_row("SELECT cost_usd FROM usage_events WHERE ts = 1", [], |r| r.get(0))
            .unwrap();
        assert!((fable - 10.0).abs() < 0.001, "fable input 1M → $10, got {fable}");

        // 5m/1h 미분리 cache_write 는 5m(1.25x) 보수 처리: 1M * $10 * 1.25 = $12.5
        let cache_only: f64 = conn
            .query_row("SELECT cost_usd FROM usage_events WHERE ts = 3", [], |r| r.get(0))
            .unwrap();
        assert!((cache_only - 12.5).abs() < 0.001, "cache_write fallback, got {cache_only}");

        let synthetic: f64 = conn
            .query_row("SELECT cost_usd FROM usage_events WHERE ts = 2", [], |r| r.get(0))
            .unwrap();
        assert_eq!(synthetic, 0.0, "단가 없는 모델은 0 유지");
    }

    #[test]
    fn test_sync_state_roundtrip() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();

        assert_eq!(get_sync_state(&conn, SYNC_WM_USAGE), None, "미설정 키는 None");
        set_sync_state(&conn, SYNC_WM_USAGE, "42").unwrap();
        assert_eq!(get_sync_state(&conn, SYNC_WM_USAGE).as_deref(), Some("42"));
        // INSERT OR REPLACE — 같은 키 재기록 시 덮어쓰기.
        set_sync_state(&conn, SYNC_WM_USAGE, "100").unwrap();
        assert_eq!(get_sync_state(&conn, SYNC_WM_USAGE).as_deref(), Some("100"));
    }

    // 회귀: cost 소급 보정(fixed>0)이 일어나면 usage 워터마크 삭제 + 세대 증가로
    // 다음 sync 가 전체 재업로드(백필)로 동작해야 한다. tool 워터마크는 cost 와 무관해 유지.
    #[test]
    fn test_recalc_resets_sync_watermarks() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        set_sync_state(&conn, SYNC_WM_USAGE, "100").unwrap();
        set_sync_state(&conn, SYNC_WM_TOOL, "50").unwrap();

        // 보정 대상 없음(fixed=0) → 워터마크/세대 유지.
        migrate(&conn).unwrap();
        assert_eq!(get_sync_state(&conn, SYNC_WM_USAGE).as_deref(), Some("100"));
        assert_eq!(get_sync_state(&conn, SYNC_RECALC_GEN), None);

        // 단가표 매칭으로 보정될 cost=0 이벤트 추가 → migrate 의 recalc 가 fixed>0.
        conn.execute_batch(
            "INSERT INTO usage_events (source, model, ts, input_tokens, cost_usd)
             VALUES ('claude', 'claude-fable-5', 1, 1000000, 0.0);",
        )
        .unwrap();
        migrate(&conn).unwrap();
        assert_eq!(get_sync_state(&conn, SYNC_WM_USAGE), None);
        assert_eq!(get_sync_state(&conn, SYNC_WM_TOOL).as_deref(), Some("50"));
        assert_eq!(get_sync_state(&conn, SYNC_RECALC_GEN).as_deref(), Some("1"));

        // 두 번째 보정 → 세대 2 (카운터 증가 확인).
        conn.execute_batch(
            "INSERT INTO usage_events (source, model, ts, input_tokens, cost_usd)
             VALUES ('claude', 'claude-fable-5', 2, 1000000, 0.0);",
        )
        .unwrap();
        migrate(&conn).unwrap();
        assert_eq!(get_sync_state(&conn, SYNC_RECALC_GEN).as_deref(), Some("2"));
    }
}
