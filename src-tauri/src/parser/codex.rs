use serde_json::Value;

use crate::models::UsageEvent;
use crate::pricing::calc_cost_usd;

use super::extract_ts;

#[derive(Clone)]
pub(super) struct State {
    thread_id: Option<String>,
    model: Option<String>,
    turn_id: Option<String>,
    is_subagent: bool,
    accepts_usage: bool,
    legacy_usage_index: u64,
}

impl Default for State {
    fn default() -> Self {
        Self {
            thread_id: None,
            model: None,
            turn_id: None,
            is_subagent: false,
            accepts_usage: true,
            legacy_usage_index: 0,
        }
    }
}

#[derive(Clone, Copy)]
pub(super) struct LineContext<'a> {
    pub project: Option<&'a str>,
    pub session_id: Option<&'a str>,
}

pub(super) fn parse_line(
    value: &Value,
    context: LineContext<'_>,
    state: &mut State,
) -> Option<UsageEvent> {
    match value.get("type").and_then(Value::as_str) {
        Some("session_meta") => {
            if state.thread_id.is_none() {
                state.thread_id = value
                    .pointer("/payload/id")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                state.is_subagent = value.pointer("/payload/source/subagent").is_some();
                state.accepts_usage = !state.is_subagent;
            }
            return None;
        }
        Some("turn_context") => {
            state.model = value
                .pointer("/payload/model")
                .and_then(Value::as_str)
                .map(str::to_owned);
            state.turn_id = value
                .pointer("/payload/turn_id")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if state.is_subagent {
                state.accepts_usage = match (&state.thread_id, &state.turn_id) {
                    (Some(thread_id), Some(turn_id)) => turn_id >= thread_id,
                    _ => false,
                };
            }
            return None;
        }
        _ => {}
    }

    if !state.accepts_usage {
        return None;
    }
    if value.get("type").and_then(Value::as_str) == Some("event_msg")
        && value.pointer("/payload/type").and_then(Value::as_str) == Some("token_count")
    {
        return parse_rollout_usage(value, context, state);
    }
    value
        .get("usage")
        .and_then(|usage| parse_legacy_usage(value, usage, context, state))
}

fn parse_rollout_usage(
    value: &Value,
    context: LineContext<'_>,
    state: &State,
) -> Option<UsageEvent> {
    let usage = value.pointer("/payload/info/last_token_usage")?;
    let (input_with_cache, cache_read, output_tokens, _, _) = token_counts(usage)?;
    let input_tokens = input_with_cache.checked_sub(cache_read)?;
    let request_id = usage_identity(value)?;
    let message_id = state
        .turn_id
        .clone()
        .or_else(|| context.session_id.map(str::to_owned))?;
    let cost_usd = state
        .model
        .as_deref()
        .map(|model| calc_cost_usd(model, input_tokens, output_tokens, cache_read, 0, 0));

    Some(UsageEvent {
        id: None,
        source: "codex".to_owned(),
        model: state.model.clone(),
        ts: extract_ts(value),
        input_tokens: Some(input_tokens),
        output_tokens: Some(output_tokens),
        cache_read: Some(cache_read),
        cache_write: Some(0),
        cache_write_5m: Some(0),
        cache_write_1h: Some(0),
        cost_usd,
        project: context.project.map(str::to_owned),
        session_id: context.session_id.map(str::to_owned),
        message_id: Some(message_id),
        request_id: Some(request_id),
    })
}

fn usage_identity(value: &Value) -> Option<String> {
    let usage = value.pointer("/payload/info/total_token_usage")?;
    let (input, cached, output, reasoning, total) = token_counts(usage)?;
    Some(format!("{input}:{cached}:{output}:{reasoning}:{total}"))
}

fn token_counts(usage: &Value) -> Option<(i64, i64, i64, i64, i64)> {
    let input = usage.get("input_tokens").and_then(Value::as_i64)?;
    let cached = usage
        .get("cached_input_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let output = usage.get("output_tokens").and_then(Value::as_i64)?;
    let reasoning = usage
        .get("reasoning_output_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let total = usage.get("total_tokens").and_then(Value::as_i64)?;
    if input < 0
        || cached < 0
        || output < 0
        || reasoning < 0
        || total < 0
        || cached > input
        || reasoning > output
        || input.checked_add(output)? != total
    {
        return None;
    }
    Some((input, cached, output, reasoning, total))
}

fn parse_legacy_usage(
    value: &Value,
    usage: &Value,
    context: LineContext<'_>,
    state: &mut State,
) -> Option<UsageEvent> {
    let model = value
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let input_tokens = usage.get("prompt_tokens").and_then(Value::as_i64)?;
    let output_tokens = usage.get("completion_tokens").and_then(Value::as_i64)?;
    if input_tokens < 0 || output_tokens < 0 {
        return None;
    }
    let message_id = value
        .get("message_id")
        .or_else(|| value.get("id"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| context.session_id.map(str::to_owned))?;
    let request_id = value
        .get("request_id")
        .or_else(|| value.get("requestId"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            let index = state.legacy_usage_index;
            state.legacy_usage_index = state.legacy_usage_index.saturating_add(1);
            format!("legacy:{index}")
        });
    let cost_usd = model
        .as_deref()
        .map(|model| calc_cost_usd(model, input_tokens, output_tokens, 0, 0, 0));

    Some(UsageEvent {
        id: None,
        source: "codex".to_owned(),
        model,
        ts: extract_ts(value),
        input_tokens: Some(input_tokens),
        output_tokens: Some(output_tokens),
        cache_read: Some(0),
        cache_write: Some(0),
        cache_write_5m: Some(0),
        cache_write_1h: Some(0),
        cost_usd,
        project: context.project.map(str::to_owned),
        session_id: context.session_id.map(str::to_owned),
        message_id: Some(message_id),
        request_id: Some(request_id),
    })
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use crate::db::insert_usage_event;
    use crate::parser::parse_jsonl;

    const TURN: &str = r#"{"timestamp":"2026-07-10T03:37:27.939Z","type":"turn_context","payload":{"turn_id":"019f4a1a-082d-71f0-85e3-ad8c73855e5c","model":"gpt-5.6-sol"}}"#;
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
    fn test_subagent_fork_snapshot_is_excluded() {
        let text =
            format!("{CHILD_META}\n{TURN}\n{TOKEN}\n{OWN_TURN}\n{NEXT_TOKEN_SAME_TIMESTAMP}\n");

        let (events, _, _) = parse_jsonl("codex", &text, None, Some("child-session"));

        assert_eq!(
            events.len(),
            1,
            "forked parent usage must not be counted again"
        );
        assert_eq!(
            events[0].message_id.as_deref(),
            Some("019f4a1b-3c5c-7e83-bd1c-e72c88465d29"),
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
        let inconsistent_total =
            TOKEN.replacen("\"total_tokens\":110}", "\"total_tokens\":999}", 1);

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
}
