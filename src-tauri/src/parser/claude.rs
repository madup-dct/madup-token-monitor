use serde_json::Value;

use crate::models::{ToolCall, UsageEvent};
use crate::pricing::calc_cost_usd;

use super::extract_ts;

#[derive(Clone, Copy)]
pub(super) struct LineContext<'a> {
    pub source: &'a str,
    pub project: Option<&'a str>,
    pub session_id: Option<&'a str>,
}

pub(super) struct LineOutput<'a> {
    pub events: &'a mut Vec<UsageEvent>,
    pub calls: &'a mut Vec<ToolCall>,
}

pub(super) fn parse_line(val: &Value, context: LineContext<'_>, output: LineOutput<'_>) {
    let ts = extract_ts(val);

    if val.get("type").and_then(Value::as_str) == Some("assistant") {
        if let Some(usage) = val.pointer("/message/usage") {
            let model = val
                .pointer("/message/model")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let input_tokens = usage.get("input_tokens").and_then(Value::as_i64);
            let output_tokens = usage.get("output_tokens").and_then(Value::as_i64);
            let cache_read = usage
                .get("cache_read_input_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let cache_creation_total = usage
                .get("cache_creation_input_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let cache_write_5m = usage
                .pointer("/cache_creation/ephemeral_5m_input_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let cache_write_1h = usage
                .pointer("/cache_creation/ephemeral_1h_input_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let (cw_5m, cw_1h) = if cache_write_5m + cache_write_1h > 0 {
                (cache_write_5m, cache_write_1h)
            } else {
                (cache_creation_total, 0)
            };
            let cache_write = cw_5m + cw_1h;
            let message_id = val
                .pointer("/message/id")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let request_id = val
                .get("requestId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let cost_usd = model.as_deref().map(|model| {
                calc_cost_usd(
                    model,
                    input_tokens.unwrap_or(0),
                    output_tokens.unwrap_or(0),
                    cache_read,
                    cw_5m,
                    cw_1h,
                )
            });

            output.events.push(UsageEvent {
                id: None,
                source: context.source.to_owned(),
                model,
                ts,
                input_tokens,
                output_tokens,
                cache_read: Some(cache_read),
                cache_write: Some(cache_write),
                cache_write_5m: Some(cw_5m),
                cache_write_1h: Some(cw_1h),
                cost_usd,
                project: context.project.map(str::to_owned),
                session_id: context.session_id.map(str::to_owned),
                message_id,
                request_id,
            });
        }

        if let Some(content) = val.pointer("/message/content").and_then(Value::as_array) {
            for item in content {
                if item.get("type").and_then(Value::as_str) == Some("tool_use") {
                    if let Some(name) = item.get("name").and_then(Value::as_str) {
                        let (mcp_server, plugin_id, effective_name) = if name == "Skill" {
                            let skill = item.pointer("/input/skill").and_then(Value::as_str);
                            let plugin = skill
                                .and_then(|skill_name| skill_name.split_once(':'))
                                .map(|(plugin_id, _)| plugin_id.to_owned());
                            let effective = match skill {
                                Some(skill_name) => format!("Skill:{skill_name}"),
                                None => name.to_owned(),
                            };
                            (None, plugin, effective)
                        } else {
                            let (server, plugin) = extract_mcp_plugin(name);
                            (server, plugin, name.to_owned())
                        };
                        output.calls.push(ToolCall {
                            id: None,
                            source: context.source.to_owned(),
                            ts,
                            tool_name: effective_name,
                            mcp_server,
                            plugin_id,
                        });
                    }
                }
            }
        }
    }
}

fn extract_mcp_plugin(name: &str) -> (Option<String>, Option<String>) {
    if let Some(rest) = name.strip_prefix("mcp__") {
        let server = rest.split("__").next().map(str::to_owned);
        if let Some(plugin_name) = server.as_deref().and_then(parse_plugin_from_mcp_server) {
            return (None, Some(plugin_name));
        }
        if let Some(server_name) = server.as_ref() {
            if crate::plugins::known_plugin_ids().contains(server_name) {
                return (None, Some(server_name.clone()));
            }
        }
        return (server, None);
    }
    if let Some((plugin_id, command)) = name.split_once(':') {
        if !plugin_id.is_empty() && !command.is_empty() && !plugin_id.contains(' ') {
            return (None, Some(plugin_id.to_owned()));
        }
    }
    (None, None)
}

fn parse_plugin_from_mcp_server(server: &str) -> Option<String> {
    let stripped = server.strip_prefix("plugin_")?;
    let plugin_name = stripped.strip_suffix("_t")?;
    if plugin_name.is_empty() {
        None
    } else {
        Some(plugin_name.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::extract_mcp_plugin;

    #[test]
    fn test_extract_mcp_plugin() {
        let (server, plugin) = extract_mcp_plugin("mcp__atlassian__jira_search");
        assert_eq!(server.as_deref(), Some("atlassian"));
        assert_eq!(plugin, None);

        let (server, plugin) = extract_mcp_plugin("mcp__mcp-atlassian__jira_search");
        assert_eq!(server.as_deref(), Some("mcp-atlassian"));
        assert_eq!(plugin, None);
        let (server, plugin) = extract_mcp_plugin("mcp__slack-bot__slack_post_message");
        assert_eq!(server.as_deref(), Some("slack-bot"));
        assert_eq!(plugin, None);

        let (server, plugin) =
            extract_mcp_plugin("mcp__plugin_oh-my-claudecode_t__list_omc_skills");
        assert_eq!(server, None);
        assert_eq!(plugin.as_deref(), Some("oh-my-claudecode"));

        let (server, plugin) = extract_mcp_plugin("dct-claude-plugin:dct-complete");
        assert_eq!(server, None);
        assert_eq!(plugin.as_deref(), Some("dct-claude-plugin"));

        let (server, plugin) = extract_mcp_plugin("Bash");
        assert_eq!(server, None);
        assert_eq!(plugin, None);
    }
}
