use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageEvent {
    pub id: Option<i64>,
    pub source: String,
    pub model: Option<String>,
    pub ts: i64,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cache_read: Option<i64>,
    pub cache_write: Option<i64>,
    /// cache_creation의 ephemeral_5m 분량 (없으면 전체를 5m로 간주)
    pub cache_write_5m: Option<i64>,
    /// cache_creation의 ephemeral_1h 분량 (있으면 1h price로 계산)
    pub cache_write_1h: Option<i64>,
    pub cost_usd: Option<f64>,
    pub project: Option<String>,
    pub session_id: Option<String>,
    /// Provider message/turn id used for dedup across mirrored log files.
    pub message_id: Option<String>,
    /// Provider request/usage identity paired with message_id for dedup.
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: Option<i64>,
    pub source: String,
    pub ts: i64,
    pub tool_name: String,
    pub mcp_server: Option<String>,
    pub plugin_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Summary {
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cache_read: i64,
    pub total_cache_write: i64,
    pub total_cost_usd: f64,
    pub total_cost_krw: f64,
    /// 응답 메시지 단위 카운트 (assistant message 1건 = 1)
    pub message_count: i64,
    /// 고유 session 카운트
    pub session_count: i64,
    pub by_source: Vec<SourceSummary>,
    pub by_model: Vec<ModelSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceSummary {
    pub source: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelSummary {
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Point {
    pub ts: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpUsage {
    pub mcp_server: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginUsage {
    pub plugin_id: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DayCount {
    pub date: String,
    pub count: i64,
    pub cost_usd: f64,
}

/// 도구(tool_name) 별 호출 횟수 — "주 사용 tools" 관찰용.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolUsage {
    pub tool_name: String,
    pub count: i64,
}
