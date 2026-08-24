use crate::models::{ToolCall, UsageEvent};
use serde_json::Value;

mod claude;
mod codex;
mod opencode;
mod pi;

#[derive(Clone, Default)]
pub struct ParseState {
    codex: codex::State,
}

pub struct JsonlChunk<'a> {
    pub source: &'a str,
    pub text: &'a str,
    pub project: Option<&'a str>,
    pub session_id: Option<&'a str>,
}

/// Parses accumulated JSONL text for `source` (claude|codex|opencode|pi).
/// Returns (events, tool_calls). Incomplete trailing line is returned as `leftover`.
pub fn parse_jsonl(
    source: &str,
    text: &str,
    project: Option<&str>,
    session_id: Option<&str>,
) -> (Vec<UsageEvent>, Vec<ToolCall>, String) {
    let mut state = ParseState::default();
    parse_jsonl_chunk(
        JsonlChunk {
            source,
            text,
            project,
            session_id,
        },
        &mut state,
    )
}

pub fn parse_jsonl_chunk(
    chunk: JsonlChunk<'_>,
    state: &mut ParseState,
) -> (Vec<UsageEvent>, Vec<ToolCall>, String) {
    let mut events = Vec::new();
    let mut calls = Vec::new();

    let mut lines = chunk.text.split('\n').peekable();
    let mut leftover = String::new();

    while let Some(line) = lines.next() {
        let is_last = lines.peek().is_none();
        let trimmed = line.trim();

        if trimmed.is_empty() {
            continue;
        }

        // Last line without trailing newline → keep as leftover
        if is_last && !chunk.text.ends_with('\n') {
            leftover = line.to_string();
            break;
        }

        let Ok(val) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };

        match chunk.source {
            "claude" => {
                let context = claude::LineContext {
                    source: chunk.source,
                    project: chunk.project,
                    session_id: chunk.session_id,
                };
                let output = claude::LineOutput {
                    events: &mut events,
                    calls: &mut calls,
                };
                claude::parse_line(&val, context, output);
            }
            "codex" => {
                let context = codex::LineContext {
                    project: chunk.project,
                    session_id: chunk.session_id,
                };
                if let Some(event) = codex::parse_line(&val, context, &mut state.codex) {
                    events.push(event);
                }
            }
            "opencode" => {
                let context = opencode::LineContext {
                    source: chunk.source,
                    project: chunk.project,
                    session_id: chunk.session_id,
                };
                if let Some(event) = opencode::parse_line(&val, context) {
                    events.push(event);
                }
            }
            "pi" => {
                let context = pi::LineContext {
                    project: chunk.project,
                    session_id: chunk.session_id,
                };
                if let Some(event) = pi::parse_line(&val, context) {
                    events.push(event);
                }
            }
            _ => {}
        }
    }

    (events, calls, leftover)
}

fn extract_ts(val: &Value) -> i64 {
    // Try common timestamp fields
    val.get("timestamp")
        .or_else(|| val.get("ts"))
        .or_else(|| val.get("created_at"))
        .and_then(|v| {
            if let Some(s) = v.as_str() {
                chrono::DateTime::parse_from_rfc3339(s)
                    .ok()
                    .map(|dt| dt.timestamp_millis())
            } else {
                v.as_i64().map(|n| {
                    // Distinguish seconds vs milliseconds
                    if n < 10_000_000_000 {
                        n * 1000
                    } else {
                        n
                    }
                })
            }
        })
        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLAUDE_LINE: &str = r#"{"type":"assistant","timestamp":"2024-01-15T10:00:00Z","message":{"model":"claude-3-5-sonnet-20241022","usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":10,"cache_read_input_tokens":5},"content":[{"type":"tool_use","name":"mcp__atlassian__jira_search","id":"t1"}]}}"#;

    const BROKEN_LINE: &str = r#"{"type":"assistant","broken_json":true"#;

    const CODEX_TURN: &str = r#"{"timestamp":"2026-07-10T03:37:27.939Z","type":"turn_context","payload":{"turn_id":"019f4a1a-082d-71f0-85e3-ad8c73855e5c","model":"gpt-5.6-sol"}}"#;
    const CODEX_TOKEN_COUNT: &str = r#"{"timestamp":"2026-07-10T03:39:24.619Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":100,"reasoning_output_tokens":20,"total_tokens":1100},"last_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10,"reasoning_output_tokens":2,"total_tokens":110},"model_context_window":353400}}}"#;

    #[test]
    fn test_parse_claude_normal() {
        let text = format!("{CLAUDE_LINE}\n");
        let (events, calls, leftover) = parse_jsonl("claude", &text, Some("proj"), Some("sess1"));
        assert_eq!(events.len(), 1);
        assert_eq!(calls.len(), 1);
        assert!(leftover.is_empty());

        let e = &events[0];
        assert_eq!(e.input_tokens, Some(100));
        assert_eq!(e.output_tokens, Some(50));
        assert_eq!(e.cache_write, Some(10));
        assert_eq!(e.cache_read, Some(5));
        assert_eq!(e.model.as_deref(), Some("claude-3-5-sonnet-20241022"));

        let c = &calls[0];
        assert_eq!(c.tool_name, "mcp__atlassian__jira_search");
        assert_eq!(c.mcp_server.as_deref(), Some("atlassian"));
    }

    #[test]
    fn test_parse_codex_rollout_token_count_uses_incremental_usage() {
        let text = format!("{CODEX_TURN}\n{CODEX_TOKEN_COUNT}\n");

        let (events, calls, leftover) = parse_jsonl("codex", &text, Some("proj"), Some("sess"));

        assert_eq!(
            events.len(),
            1,
            "Codex token_count must produce one usage event"
        );
        assert!(calls.is_empty());
        assert!(leftover.is_empty());

        let event = &events[0];
        assert_eq!(event.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(event.input_tokens, Some(60));
        assert_eq!(event.cache_read, Some(40));
        assert_eq!(event.output_tokens, Some(10));
        assert_eq!(event.cache_write, Some(0));
        assert_eq!(
            event.input_tokens.unwrap_or(0)
                + event.cache_read.unwrap_or(0)
                + event.output_tokens.unwrap_or(0),
            110,
        );
    }

    #[test]
    fn test_parse_codex_incremental_chunks_preserve_context_and_identity() {
        let mut state = ParseState::default();
        let (_, _, turn_leftover) = parse_jsonl_chunk(
            JsonlChunk {
                source: "codex",
                text: &format!("{CODEX_TURN}\n"),
                project: Some("proj"),
                session_id: Some("sess"),
            },
            &mut state,
        );
        assert!(turn_leftover.is_empty());

        let (events, _, usage_leftover) = parse_jsonl_chunk(
            JsonlChunk {
                source: "codex",
                text: &format!("{CODEX_TOKEN_COUNT}\n"),
                project: Some("proj"),
                session_id: Some("sess"),
            },
            &mut state,
        );

        assert!(usage_leftover.is_empty());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(
            events[0].message_id.as_deref(),
            Some("019f4a1a-082d-71f0-85e3-ad8c73855e5c"),
        );
        assert_eq!(
            events[0].request_id.as_deref(),
            Some("1000:400:100:20:1100")
        );
    }

    #[test]
    fn test_parse_broken_line_skipped() {
        let text = format!("{BROKEN_LINE}\n");
        let (events, calls, _) = parse_jsonl("claude", &text, None, None);
        assert!(events.is_empty());
        assert!(calls.is_empty());
    }

    #[test]
    fn test_partial_line_becomes_leftover() {
        // No trailing newline → last line is partial
        let text = format!("{CLAUDE_LINE}\n{BROKEN_LINE}");
        let (events, _, leftover) = parse_jsonl("claude", &text, None, None);
        assert_eq!(events.len(), 1);
        assert_eq!(leftover, BROKEN_LINE);
    }

    #[test]
    fn test_empty_text() {
        let (events, calls, leftover) = parse_jsonl("claude", "", None, None);
        assert!(events.is_empty());
        assert!(calls.is_empty());
        assert!(leftover.is_empty());
    }
}
