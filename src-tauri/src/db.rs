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
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;
    migrate(&conn)?;
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
            ON tool_calls(source, ts, tool_name);",
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
    let _ = conn.execute(
        "UPDATE tool_calls SET plugin_id = NULL
         WHERE plugin_id IS NOT NULL AND plugin_id = mcp_server",
        [],
    );
    // SQLite SUBSTR(s, start, length) — 1-indexed. 'plugin_'(7) 다음 시작, 끝 '_t'(2) 제거.
    let _ = conn.execute(
        "UPDATE tool_calls
         SET plugin_id = SUBSTR(mcp_server, 8, LENGTH(mcp_server) - 9)
         WHERE mcp_server LIKE 'plugin_%_t'
           AND LENGTH(mcp_server) > 9",
        [],
    );
    // Claude Code 플러그인은 MCP TOP에 보이지 않게 mcp_server NULL로 정리.
    let _ = conn.execute(
        "UPDATE tool_calls
         SET mcp_server = NULL
         WHERE mcp_server LIKE 'plugin_%_t'",
        [],
    );
    // 플러그인 레지스트리(~/.claude/plugins/cache 폴더명) 기준으로 옛 분류 보정 —
    // 설치된 플러그인 ID와 일치하는 mcp_server 는 plugin_id 로 이동.
    for plugin_id in crate::plugins::known_plugin_ids() {
        let _ = conn.execute(
            "UPDATE tool_calls
             SET plugin_id = ?1, mcp_server = NULL
             WHERE mcp_server = ?1",
            params![plugin_id],
        );
    }

    Ok(())
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
