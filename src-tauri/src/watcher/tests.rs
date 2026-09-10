use super::{detect_source_for, persist_since, reset_if_truncated, watch_dirs_for, FileState};
use crate::models::{ToolCall, UsageEvent};
use std::path::Path;

#[test]
fn configured_codex_home_is_watched_and_classified_as_codex() {
    // Given: Codex is running from an isolated home with another account token.
    let home = Path::new("/users/example");
    let codex_home = Path::new("/runtime/codex-home");
    let session = codex_home.join("sessions/2026/07/15/rollout.jsonl");

    // When: the watcher resolves its roots and classifies that session.
    let dirs = watch_dirs_for(home, codex_home);
    let source = detect_source_for(&session, &codex_home.join("sessions"));

    // Then: usage from the configured Codex home enters the Codex pipeline.
    assert!(dirs.contains(&codex_home.join("sessions")));
    assert_eq!(source, "codex");
}

#[test]
fn default_codex_usage_does_not_freeze_when_account_home_differs() {
    // Given: account limits use Orca's isolated Codex home, while a regular
    // Codex CLI session continues writing to the user's default home.
    let home = Path::new("/users/example");
    let account_home = Path::new("/runtime/codex-home");
    let default_session = home.join(".codex/sessions/2026/07/15/rollout.jsonl");

    // When: the watcher resolves every usage root.
    let dirs = watch_dirs_for(home, account_home);
    let source = detect_source_for(&default_session, &account_home.join("sessions"));

    // Then: both session streams remain observable after an account switch.
    assert!(
        dirs.contains(&home.join(".codex/sessions")),
        "default Codex usage root is missing, so its token total will freeze"
    );
    assert!(dirs.contains(&account_home.join("sessions")));
    assert_eq!(source, "codex");
}

#[test]
fn orca_runtime_home_is_codex_even_when_account_home_is_default() {
    // Given: orca 계정 홈이 앱 기동 *후* 생겨 OnceLock 은 기본 ~/.codex 를 가리킨다.
    // 주기 재스캔은 orca 세션을 걷지만, detect_source 는 여전히 기본 홈 sessions 를
    // 인자로 받으므로 orca 경로는 starts_with 브랜치를 못 탄다.
    let default_sessions = Path::new("/users/example/.codex/sessions");
    let orca_session = Path::new(
        "/users/example/Library/Application Support/orca/codex-runtime-home/home/sessions/2026/07/28/rollout.jsonl",
    );

    // When: 기본 홈 sessions 로는 prefix-match 되지 않는 orca 파일을 분류한다.
    let source = detect_source_for(orca_session, default_sessions);

    // Then: `codex-runtime-home` substring 브랜치가 잡아 codex 로 분류된다
    // (없으면 "unknown" 으로 조용히 드롭 → orca 수집 0).
    assert_eq!(source, "codex");
}

#[test]
fn truncated_file_resets_offset_and_parser_state() {
    let state = FileState {
        offset: 100,
        buffer: "partial".to_owned(),
        parser: crate::parser::ParseState::default(),
    };

    let reset = reset_if_truncated(10, state);

    assert_eq!(reset.offset, 0);
    assert!(reset.buffer.is_empty());
}

fn usage_event(ts: i64, message_id: &str) -> UsageEvent {
    UsageEvent {
        id: None,
        source: "claude".into(),
        model: Some("claude-opus-4-8".into()),
        ts,
        input_tokens: Some(100),
        output_tokens: Some(10),
        cache_read: None,
        cache_write: None,
        cache_write_5m: None,
        cache_write_1h: None,
        cost_usd: Some(1.0),
        project: None,
        session_id: Some("sess".into()),
        message_id: Some(message_id.into()),
        request_id: Some(message_id.into()),
    }
}

fn tool_call(ts: i64, tool_name: &str) -> ToolCall {
    ToolCall {
        id: None,
        source: "claude".into(),
        ts,
        tool_name: tool_name.into(),
        mcp_server: None,
        plugin_id: None,
    }
}

// 회귀: 파일 offset 이 메모리 전용이라 재기동마다 JSONL 을 전량 재파싱한다.
// 보존 컷오프 이전 이벤트를 걸러내지 않으면 retention 이 지운 옛 데이터가 매번 되살아난다.
#[test]
fn persist_skips_events_older_than_retention_cutoff() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    crate::db::migrate(&conn).unwrap();
    let cutoff = 1_000_000i64;

    persist_since(
        &conn,
        &[
            usage_event(cutoff - 1, "old"),
            usage_event(cutoff, "boundary"),
            usage_event(cutoff + 1, "new"),
        ],
        &[tool_call(cutoff - 1, "Read"), tool_call(cutoff, "Edit")],
        cutoff,
    )
    .unwrap();

    let events: i64 = conn
        .query_row("SELECT COUNT(*) FROM usage_events", [], |r| r.get(0))
        .unwrap();
    let calls: i64 = conn
        .query_row("SELECT COUNT(*) FROM tool_calls", [], |r| r.get(0))
        .unwrap();
    assert_eq!(events, 2, "컷오프 시점(=경계) 이상만 저장");
    assert_eq!(calls, 1);

    let oldest: i64 = conn
        .query_row("SELECT MIN(ts) FROM usage_events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(oldest, cutoff);
}
