use serde_json::Value;

use crate::models::UsageEvent;
use crate::pricing::calc_cost_usd;

use super::extract_ts;

#[derive(Clone, Copy)]
pub(super) struct LineContext<'a> {
    pub source: &'a str,
    pub project: Option<&'a str>,
    pub session_id: Option<&'a str>,
}

pub(super) fn parse_line(value: &Value, context: LineContext<'_>) -> Option<UsageEvent> {
    let usage = value.get("usage").or_else(|| value.get("tokens"))?;
    let model = value
        .get("model")
        .or_else(|| value.get("modelId"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let input_tokens = usage
        .get("input_tokens")
        .or_else(|| usage.get("prompt_tokens"))
        .and_then(Value::as_i64);
    let output_tokens = usage
        .get("output_tokens")
        .or_else(|| usage.get("completion_tokens"))
        .and_then(Value::as_i64);
    let cost_usd = model.as_deref().map(|model| {
        calc_cost_usd(
            model,
            input_tokens.unwrap_or(0),
            output_tokens.unwrap_or(0),
            0,
            0,
            0,
        )
    });

    Some(UsageEvent {
        id: None,
        source: context.source.to_owned(),
        model,
        ts: extract_ts(value),
        input_tokens,
        output_tokens,
        cache_read: Some(0),
        cache_write: Some(0),
        cache_write_5m: Some(0),
        cache_write_1h: Some(0),
        cost_usd,
        project: context.project.map(str::to_owned),
        session_id: context.session_id.map(str::to_owned),
        message_id: None,
        request_id: None,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{parse_line, LineContext};

    #[test]
    fn test_parse_line_preserves_legacy_usage_shape() {
        let value = json!({
            "timestamp": 1,
            "modelId": "unknown-model",
            "tokens": {"prompt_tokens": 12, "completion_tokens": 3}
        });

        let event = parse_line(
            &value,
            LineContext {
                source: "opencode",
                project: Some("proj"),
                session_id: Some("session"),
            },
        )
        .unwrap();

        assert_eq!(event.ts, 1_000);
        assert_eq!(event.input_tokens, Some(12));
        assert_eq!(event.output_tokens, Some(3));
        assert_eq!(event.project.as_deref(), Some("proj"));
        assert_eq!(event.session_id.as_deref(), Some("session"));
    }
}
