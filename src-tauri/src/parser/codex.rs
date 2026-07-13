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
    last_rollout_usage_identity: Option<String>,
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
            last_rollout_usage_identity: None,
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
    state: &mut State,
) -> Option<UsageEvent> {
    let usage = value.pointer("/payload/info/last_token_usage")?;
    let (input_with_cache, cache_read, output_tokens, _, _) = token_counts(usage)?;
    let input_tokens = input_with_cache.checked_sub(cache_read)?;
    let request_id = usage_identity(value)?;
    if state.last_rollout_usage_identity.as_deref() == Some(request_id.as_str()) {
        return None;
    }
    let message_id = state
        .turn_id
        .clone()
        .or_else(|| context.session_id.map(str::to_owned))?;
    let cost_usd = state
        .model
        .as_deref()
        .map(|model| calc_cost_usd(model, input_tokens, output_tokens, cache_read, 0, 0));
    state.last_rollout_usage_identity = Some(request_id.clone());

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
mod tests;
