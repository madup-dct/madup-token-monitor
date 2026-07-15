// W2 Rust models.rs 기준 TypeScript 타입 정의

export interface Summary {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read: number;
  total_cache_write: number;
  total_cost_usd: number;
  total_cost_krw: number;
  message_count: number;
  session_count: number;
  by_source: SourceSummary[];
  by_model: ModelSummary[];
}

export interface SourceSummary {
  source: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface ModelSummary {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number;
}

export interface Point {
  ts: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number;
}

export interface McpUsage {
  mcp_server: string;
  count: number;
}

export interface PluginUsage {
  plugin_id: string;
  count: number;
}

export interface ToolUsage {
  tool_name: string;
  count: number;
}

export interface DayCount {
  date: string;
  count: number;
  cost_usd: number;
}

export interface CodexRateLimitWindow {
  readonly used_percent: number;
  readonly window_minutes: number;
  readonly resets_at: number;
}

export interface CodexRateLimitSnapshot {
  readonly limit_id: string;
  readonly limit_name: string | null;
  readonly plan_type: string | null;
  readonly primary: CodexRateLimitWindow | null;
  readonly secondary: CodexRateLimitWindow | null;
  readonly observed_at: number;
}

/// Anthropic OAuth usage API 의 한도 창 1개 — Rust LimitWindow 와 동일 shape.
export interface LimitWindow {
  kind: string; // "session" | "weekly_all" | "weekly_scoped" | (미래 확장)
  scope_model: string | null;
  utilization: number; // 사용률 % 0~100
  resets_at: string; // RFC3339
}

export type AccountLimitProvider = "claude" | "codex";

export interface AccountLimitRow {
  provider: AccountLimitProvider;
  account_id: string;
  account_email: string;
  owner_email: string;
  owner_name: string | null;
  plan_type: string | null;
  windows: LimitWindow[];
  fetched_at: string;
  updated_at: string;
}

export type Range = "1d" | "7d" | "30d" | "90d" | "365d" | "all";

export interface LeaderboardEntry {
  rank: number;
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  message_count: number;
  total_tokens: number;
  cost_usd: number;
}

// 권한 4단계 (supabase migrations/0012)
export type AppRole = "user" | "team_leader" | "manager" | "admin";

export interface Team {
  id: string;
  name: string;
  slug: string;
  created_by: string;
  created_at: string;
}

export interface TeamMember {
  team_id: string;
  user_id: string;
  role: "owner" | "admin" | "member";
  joined_at: string;
}

export interface TeamMemberWithProfile extends TeamMember {
  profile: {
    name: string | null;
    email: string | null;
    avatar_url: string | null;
    slack_handle: string | null;
  } | null;
}

export interface TeamAggregate {
  team_id: string;
  name: string;
  slug: string;
  member_count: number;
  total_tokens: number;
  total_cost: number;
}

export interface TeamMemberUsage {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  total_tokens: number;
  total_cost: number;
}
