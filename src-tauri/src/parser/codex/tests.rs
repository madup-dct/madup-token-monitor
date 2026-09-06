use rusqlite::Connection;

use crate::db::insert_usage_event;
use crate::parser::parse_jsonl;

const TURN: &str = r#"{"timestamp":"2026-07-10T03:37:27.939Z","type":"turn_context","payload":{"turn_id":"019f4a1a-082d-71f0-85e3-ad8c73855e5c","model":"gpt-5.6-sol"}}"#;
const NEXT_TURN: &str = r#"{"timestamp":"2026-07-10T03:40:00.000Z","type":"turn_context","payload":{"turn_id":"019f4a1c-082d-71f0-85e3-ad8c73855e5c","model":"gpt-5.6-sol"}}"#;
const TOKEN: &str = r#"{"timestamp":"2026-07-10T03:39:24.619Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":100,"reasoning_output_tokens":20,"total_tokens":1100},"last_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10,"reasoning_output_tokens":2,"total_tokens":110}}}}"#;
const NEXT_TOKEN_SAME_TIMESTAMP: &str = r#"{"timestamp":"2026-07-10T03:39:24.619Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1100,"cached_input_tokens":440,"output_tokens":110,"reasoning_output_tokens":22,"total_tokens":1210},"last_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10,"reasoning_output_tokens":2,"total_tokens":110}}}}"#;
const LEGACY_TOKEN: &str = r#"{"timestamp":"2024-01-15T10:00:00Z","model":"gpt-4o","usage":{"prompt_tokens":100,"completion_tokens":20}}"#;
const CHILD_META: &str = r#"{"timestamp":"2026-07-10T03:38:46.742Z","type":"session_meta","payload":{"id":"019f4a1b-33da-7391-bb58-a82dc43f6691","source":{"subagent":{"thread_spawn":{"parent_thread_id":"019f4a18-07a6-7423-8dd0-96a0bb5b02c6"}}}}}"#;
const OWN_TURN: &str = r#"{"timestamp":"2026-07-10T03:38:49.977Z","type":"turn_context","payload":{"turn_id":"019f4a1b-3c5c-7e83-bd1c-e72c88465d29","model":"gpt-5.6-sol"}}"#;

fn test_connection() -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch(
            "CREATE TABLE usage_events (
                id INTEGER PRIMARY KEY, source TEXT NOT NULL, model TEXT, ts INTEGER NOT NULL,
                input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER,
                cache_write INTEGER, cache_write_5m INTEGER, cache_write_1h INTEGER,
                cost_usd REAL, project TEXT, session_id TEXT, message_id TEXT, request_id TEXT
            );
            CREATE UNIQUE INDEX uniq_usage_msg ON usage_events(message_id, request_id);",
        )
        .unwrap();
    connection
}

#[test]
fn test_fork_replay_and_restart_are_deduplicated() {
    let connection = test_connection();
    let text = format!("{TURN}\n{TOKEN}\n");

    for session_id in ["parent-session", "child-fork-session"] {
        let (events, _, _) = parse_jsonl("codex", &text, None, Some(session_id));
        assert_eq!(events.len(), 1);
        insert_usage_event(&connection, &events[0]).unwrap();
    }

    let row_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM usage_events", [], |row| row.get(0))
        .unwrap();
    assert_eq!(row_count, 1);
}

#[test]
fn test_same_timestamp_distinct_usage_vectors_are_preserved() {
    let connection = test_connection();
    let text = format!("{TURN}\n{TOKEN}\n{NEXT_TOKEN_SAME_TIMESTAMP}\n");
    let (events, _, _) = parse_jsonl("codex", &text, None, Some("session"));

    assert_eq!(events.len(), 2);
    for event in &events {
        insert_usage_event(&connection, event).unwrap();
    }

    let row_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM usage_events", [], |row| row.get(0))
        .unwrap();
    assert_eq!(row_count, 2);
}

#[test]
fn test_replayed_cumulative_usage_after_new_turn_is_ignored() {
    let text = format!("{TURN}\n{TOKEN}\n{NEXT_TURN}\n{TOKEN}\n");
    let (events, _, _) = parse_jsonl("codex", &text, None, Some("session"));

    assert_eq!(
        events.len(),
        1,
        "new turn must not replay the prior cumulative usage"
    );
}

#[test]
fn test_subagent_fork_snapshot_is_excluded() {
    let text = format!("{CHILD_META}\n{TURN}\n{TOKEN}\n{OWN_TURN}\n{NEXT_TOKEN_SAME_TIMESTAMP}\n");

    let (events, _, _) = parse_jsonl("codex", &text, None, Some("child-session"));

    assert_eq!(
        events.len(),
        1,
        "forked parent usage must not be counted again"
    );
    assert_eq!(
        events[0].message_id.as_deref(),
        Some("019f4a1b-3c5c-7e83-bd1c-e72c88465d29")
    );
    assert_eq!(
        events[0].request_id.as_deref(),
        Some("1100:440:110:22:1210")
    );
}

#[test]
fn test_rollout_usage_requires_token_count_envelope_and_stable_identity() {
    let wrong_envelope = TOKEN.replacen("\"token_count\"", "\"other\"", 1);
    let missing_total = TOKEN.replacen("\"total_token_usage\"", "\"missing_total_usage\"", 1);

    for token in [wrong_envelope, missing_total] {
        let text = format!("{TURN}\n{token}\n");
        let (events, _, _) = parse_jsonl("codex", &text, None, Some("session"));
        assert!(events.is_empty());
    }
}

#[test]
fn test_rollout_usage_rejects_invalid_token_counts() {
    let negative = TOKEN.replacen("\"input_tokens\":100", "\"input_tokens\":-100", 1);
    let cache_exceeds_input = TOKEN.replacen(
        "\"cached_input_tokens\":40",
        "\"cached_input_tokens\":140",
        1,
    );
    let inconsistent_total = TOKEN.replacen("\"total_tokens\":110}", "\"total_tokens\":999}", 1);

    for token in [negative, cache_exceeds_input, inconsistent_total] {
        let text = format!("{TURN}\n{token}\n");
        let (events, _, _) = parse_jsonl("codex", &text, None, Some("session"));
        assert!(events.is_empty());
    }
}

#[test]
fn test_legacy_restart_is_deduplicated() {
    let connection = test_connection();
    let text = format!("{LEGACY_TOKEN}\n");

    for _ in 0..2 {
        let (events, _, _) = parse_jsonl("codex", &text, None, Some("legacy-session"));
        assert_eq!(events.len(), 1);
        insert_usage_event(&connection, &events[0]).unwrap();
    }

    let row_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM usage_events", [], |row| row.get(0))
        .unwrap();
    assert_eq!(row_count, 1);
}

#[test]
fn test_gpt_6_astra_max_counts_and_prices_usage_once() {
    let turn = serde_json::json!({
        "type": "turn_context",
        "payload": {"turn_id": "astra-turn", "model": "gpt-6-astra", "effort": "max"}
    });
    let usage = serde_json::json!({
        "input_tokens": 100_000,
        "cached_input_tokens": 40_000,
        "cache_write_input_tokens": 0,
        "output_tokens": 1_000,
        "reasoning_output_tokens": 800,
        "total_tokens": 101_000
    });
    let token = serde_json::json!({
        "timestamp": "2026-09-06T01:00:00Z",
        "type": "event_msg",
        "payload": {"type": "token_count", "info": {
            "total_token_usage": usage,
            "last_token_usage": usage,
            "model_context_window": 828_400
        }}
    });
    let text = format!("{turn}\n{token}\n{token}\n");
    let (events, _, _) = parse_jsonl("codex", &text, None, Some("astra-session"));

    assert_eq!(events.len(), 1);
    assert_eq!(events[0].model.as_deref(), Some("gpt-6-astra"));
    assert_eq!(events[0].input_tokens, Some(60_000));
    assert_eq!(events[0].cache_read, Some(40_000));
    assert_eq!(events[0].output_tokens, Some(1_000));
    assert!((events[0].cost_usd.unwrap() - 0.69).abs() < 1e-9);
}
