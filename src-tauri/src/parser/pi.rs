use serde_json::Value;

use crate::models::UsageEvent;
use crate::pricing::calc_cost_usd;

use super::extract_ts;

#[derive(Clone, Copy)]
pub(super) struct LineContext<'a> {
    pub project: Option<&'a str>,
    pub session_id: Option<&'a str>,
}

/// Pi can run multiple providers in one session. Only usage produced through the
/// Codex provider belongs in the app's existing `codex` source bucket.
pub(super) fn parse_line(value: &Value, context: LineContext<'_>) -> Option<UsageEvent> {
    if value.get("type").and_then(Value::as_str) != Some("message") {
        return None;
    }

    let message = value.get("message")?;
    if message.get("role").and_then(Value::as_str) != Some("assistant")
        || message.get("provider").and_then(Value::as_str) != Some("openai-codex")
    {
        return None;
    }

    let usage = message.get("usage")?;
    let input_tokens = non_negative_i64(usage.get("input")?)?;
    let output_tokens = non_negative_i64(usage.get("output")?)?;
    let cache_read = optional_non_negative_i64(usage.get("cacheRead"))?;
    let cache_write = optional_non_negative_i64(usage.get("cacheWrite"))?;

    if let Some(total) = usage.get("totalTokens") {
        let total = non_negative_i64(total)?;
        let calculated = input_tokens
            .checked_add(output_tokens)?
            .checked_add(cache_read)?
            .checked_add(cache_write)?;
        if calculated != total {
            return None;
        }
    }

    let model = message
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let cost_usd = usage
        .pointer("/cost/total")
        .and_then(Value::as_f64)
        .filter(|cost| cost.is_finite() && *cost >= 0.0)
        .or_else(|| {
            model.as_deref().map(|model| {
                // cacheWrite는 Pi의 provider-generic 필드이며 Anthropic의 5m/1h
                // cache creation과 같은 의미라고 단정할 수 없어 단가 fallback에서 제외한다.
                calc_cost_usd(model, input_tokens, output_tokens, cache_read, 0, 0)
            })
        });

    // Pi's line id is preserved when a session is branched, while responseId is
    // provider-issued. Their pair is stable across restarts and mirrored logs.
    let line_id = value.get("id").and_then(Value::as_str)?;
    let response_id = message.get("responseId").and_then(Value::as_str)?;

    Some(UsageEvent {
        id: None,
        source: "codex".to_owned(),
        model,
        ts: extract_ts(value),
        input_tokens: Some(input_tokens),
        output_tokens: Some(output_tokens),
        cache_read: Some(cache_read),
        cache_write: Some(cache_write),
        cache_write_5m: Some(0),
        cache_write_1h: Some(0),
        cost_usd,
        project: context.project.map(str::to_owned),
        session_id: context.session_id.map(str::to_owned),
        message_id: Some(format!("pi:{line_id}")),
        request_id: Some(response_id.to_owned()),
    })
}

fn non_negative_i64(value: &Value) -> Option<i64> {
    value.as_i64().filter(|count| *count >= 0)
}

fn optional_non_negative_i64(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(value) => non_negative_i64(value),
        None => Some(0),
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use serde_json::{json, Value};

    use crate::db::insert_usage_event;

    use super::{parse_line, LineContext};

    fn context<'a>() -> LineContext<'a> {
        LineContext {
            project: Some("project"),
            session_id: Some("session"),
        }
    }

    fn pi_message() -> Value {
        json!({
            "type": "message",
            "id": "line-1",
            "timestamp": "2026-08-24T07:12:47.409Z",
            "message": {
                "role": "assistant",
                "provider": "openai-codex",
                "model": "gpt-5.6-sol",
                "responseId": "response-1",
                "usage": {
                    "input": 437,
                    "output": 212,
                    "cacheRead": 6656,
                    "cacheWrite": 0,
                    "totalTokens": 7305,
                    "cost": {"total": 0.011873}
                }
            }
        })
    }

    #[test]
    fn parses_nested_codex_usage() {
        let event = parse_line(&pi_message(), context()).unwrap();

        assert_eq!(event.source, "codex");
        assert_eq!(event.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(event.input_tokens, Some(437));
        assert_eq!(event.output_tokens, Some(212));
        assert_eq!(event.cache_read, Some(6656));
        assert_eq!(event.cache_write, Some(0));
        assert_eq!(event.cost_usd, Some(0.011873));
        assert_eq!(event.message_id.as_deref(), Some("pi:line-1"));
        assert_eq!(event.request_id.as_deref(), Some("response-1"));
    }

    #[test]
    fn ignores_other_providers_and_invalid_usage() {
        let mut other_provider = pi_message();
        other_provider["message"]["provider"] = json!("anthropic");
        assert!(parse_line(&other_provider, context()).is_none());

        let mut inconsistent_total = pi_message();
        inconsistent_total["message"]["usage"]["totalTokens"] = json!(999);
        assert!(parse_line(&inconsistent_total, context()).is_none());

        let mut negative = pi_message();
        negative["message"]["usage"]["input"] = json!(-1);
        assert!(parse_line(&negative, context()).is_none());
    }

    #[test]
    fn restart_and_branched_session_are_deduplicated() {
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

        for session_id in ["original", "branch"] {
            let event = parse_line(
                &pi_message(),
                LineContext {
                    project: None,
                    session_id: Some(session_id),
                },
            )
            .unwrap();
            insert_usage_event(&connection, &event).unwrap();
        }

        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM usage_events", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
}
