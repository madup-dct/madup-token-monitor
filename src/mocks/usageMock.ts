import type {
  Summary,
  Point,
  McpUsage,
  PluginUsage,
  DayCount,
  Range,
  LeaderboardEntry,
  ToolUsage,
} from "@/types/models";
import type { UsageSource } from "@/lib/usage-sources";

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function rangeToDays(range: Range): number {
  if (range === "1d") return 1;
  if (range === "7d") return 7;
  return 30;
}

export function buildMockSummary(range: Range, source?: UsageSource): Summary {
  const days = rangeToDays(range);
  const sourceFactor = source === "claude" ? 0.65 : source === "codex" ? 0.35 : 1;
  const inp = Math.floor(randomInt(100_000, 400_000) * days * sourceFactor);
  const out = Math.floor(randomInt(20_000, 80_000) * days * sourceFactor);
  const cr = Math.floor(randomInt(10_000, 80_000) * days * sourceFactor);
  const cw = source === "codex" ? 0 : Math.floor(randomInt(5_000, 40_000) * days * sourceFactor);
  const cost = (inp * 3 + out * 15 + cr * 0.3) / 1_000_000;
  const bySource = source
    ? [{ source, input_tokens: inp, output_tokens: out, cost_usd: cost }]
    : [
        {
          source: "claude",
          input_tokens: Math.floor(inp * 0.65),
          output_tokens: Math.floor(out * 0.65),
          cost_usd: cost * 0.65,
        },
        {
          source: "codex",
          input_tokens: Math.floor(inp * 0.35),
          output_tokens: Math.floor(out * 0.35),
          cost_usd: cost * 0.35,
        },
      ];
  const byModel =
    source === "codex"
      ? [
          {
            model: "gpt-5.6-sol",
            input_tokens: inp,
            output_tokens: out,
            cache_read: cr,
            cache_write: 0,
            cost_usd: cost,
          },
        ]
      : source === "claude"
        ? [
            {
              model: "claude-opus-4-7",
              input_tokens: inp,
              output_tokens: out,
              cache_read: cr,
              cache_write: cw,
              cost_usd: cost,
            },
          ]
        : [
            {
              model: "claude-opus-4-7",
              input_tokens: Math.floor(inp * 0.65),
              output_tokens: Math.floor(out * 0.65),
              cache_read: Math.floor(cr * 0.65),
              cache_write: cw,
              cost_usd: cost * 0.65,
            },
            {
              model: "gpt-5.6-sol",
              input_tokens: Math.floor(inp * 0.35),
              output_tokens: Math.floor(out * 0.35),
              cache_read: Math.floor(cr * 0.35),
              cache_write: 0,
              cost_usd: cost * 0.35,
            },
          ];

  return {
    total_input_tokens: inp,
    total_output_tokens: out,
    total_cache_read: cr,
    total_cache_write: cw,
    total_cost_usd: cost,
    total_cost_krw: cost * 1380,
    message_count: randomInt(50, 500) * days,
    session_count: randomInt(1, 5) * days,
    by_source: bySource,
    by_model: byModel,
  };
}

export function buildMockTimeseries(range: Range, source?: UsageSource): Point[] {
  const days = rangeToDays(range);
  const sourceFactor = source === "claude" ? 0.65 : source === "codex" ? 0.35 : 1;
  const now = Date.now();
  return Array.from({ length: days * 4 }, (_, i) => {
    const ts = now - (days * 4 - 1 - i) * 6 * 3_600_000;
    const inp = Math.floor(randomInt(5_000, 60_000) * sourceFactor);
    const out = Math.floor(randomInt(1_000, 15_000) * sourceFactor);
    const cr = Math.floor(randomInt(80_000, 400_000) * sourceFactor);
    const cw = source === "codex" ? 0 : Math.floor(randomInt(20_000, 100_000) * sourceFactor);
    return {
      ts,
      input_tokens: inp,
      output_tokens: out,
      cache_read: cr,
      cache_write: cw,
      cost_usd: (inp * 3 + out * 15 + cr * 0.3) / 1_000_000,
    };
  });
}

export function buildMockTopMcp(range: Range): McpUsage[] {
  const days = rangeToDays(range);
  return [
    { mcp_server: "mcp-atlassian", count: randomInt(60, 200) },
    { mcp_server: "playwright", count: randomInt(40, 160) },
    { mcp_server: "slack-bot", count: randomInt(30, 120) },
    { mcp_server: "github", count: randomInt(20, 100) },
    { mcp_server: "filesystem", count: randomInt(15, 80) },
    { mcp_server: "postgres", count: randomInt(10, 60) },
    { mcp_server: "google-drive", count: randomInt(8, 50) },
    { mcp_server: "fetch", count: randomInt(5, 40) },
    { mcp_server: "memory", count: randomInt(3, 30) },
    { mcp_server: "sequential-thinking", count: randomInt(2, 20) },
  ].map((m) => ({ ...m, count: Math.max(1, Math.round((m.count * days) / 7)) }));
}

export function buildMockTopPlugins(range: Range): PluginUsage[] {
  const days = rangeToDays(range);
  return [
    { plugin_id: "oh-my-claudecode", count: randomInt(50, 150) },
    { plugin_id: "dct-claude-plugin", count: randomInt(30, 100) },
    { plugin_id: "impeccable", count: randomInt(20, 80) },
    { plugin_id: "frontend-design", count: randomInt(10, 60) },
    { plugin_id: "ui-ux-pro-max", count: randomInt(5, 40) },
  ].map((p) => ({ ...p, count: Math.max(1, Math.round((p.count * days) / 7)) }));
}

export function buildMockTopTools(range: Range): ToolUsage[] {
  const days = rangeToDays(range);
  return [
    { tool_name: "Read", count: randomInt(200, 500) },
    { tool_name: "Edit", count: randomInt(150, 400) },
    { tool_name: "Bash", count: randomInt(120, 350) },
    { tool_name: "Grep", count: randomInt(80, 250) },
    { tool_name: "Write", count: randomInt(60, 200) },
    { tool_name: "mcp__atlassian__jira_search", count: randomInt(30, 120) },
    { tool_name: "TodoWrite", count: randomInt(20, 100) },
    { tool_name: "mcp__playwright__browser_click", count: randomInt(10, 60) },
  ].map((t) => ({ ...t, count: Math.max(1, Math.round((t.count * days) / 7)) }));
}

export function buildMockHeatmap(days = 30, source?: UsageSource): DayCount[] {
  const sourceFactor = source === "claude" ? 0.65 : source === "codex" ? 0.35 : 1;
  return Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1 - i));
    return {
      date: d.toISOString().slice(0, 10),
      count: Math.round(randomInt(0, 40) * sourceFactor),
      cost_usd: Math.random() * 2 * sourceFactor,
    };
  });
}

export function buildMockCompanyTopMcp(): McpUsage[] {
  return [
    { mcp_server: "mcp-atlassian", count: randomInt(500, 2000) },
    { mcp_server: "playwright", count: randomInt(300, 1500) },
    { mcp_server: "slack-bot", count: randomInt(200, 1200) },
    { mcp_server: "github", count: randomInt(150, 1000) },
    { mcp_server: "filesystem", count: randomInt(100, 800) },
    { mcp_server: "postgres", count: randomInt(80, 600) },
    { mcp_server: "google-drive", count: randomInt(60, 500) },
    { mcp_server: "fetch", count: randomInt(40, 400) },
    { mcp_server: "memory", count: randomInt(30, 300) },
    { mcp_server: "sequential-thinking", count: randomInt(20, 200) },
  ];
}

export function buildMockLeaderboard(myEmail?: string | null): LeaderboardEntry[] {
  const seeds = [
    "dokdo2013",
    "akagaeng",
    "fivetaku",
    "shindonghwi",
    "hoony-studio",
    "FMan-World",
    "heesumin-madup",
    "sharkp08",
    "andyleeboo",
    myEmail ? myEmail.split("@")[0] : "me",
    "jungsooyun",
    "Byun11",
    "aldegad",
    "yujin-park",
    "mskim-madup",
  ];
  const baseTokens = [159_700_000, 123_100_000, 63_500_000, 54_400_000, 51_100_000];
  return seeds.map((handle, i) => {
    const tokens =
      i < baseTokens.length
        ? baseTokens[i]
        : Math.max(
            8_000_000,
            baseTokens[baseTokens.length - 1] - i * 4_000_000 - randomInt(-2_000_000, 2_000_000)
          );
    const messages = Math.max(20, Math.round(tokens / randomInt(300_000, 800_000)));
    const cost = (tokens / 1_000_000) * randomInt(1, 4) + randomInt(0, 30);
    return {
      rank: i + 1,
      user_id: `mock-${i}`,
      display_name: handle,
      avatar_url: null,
      message_count: messages,
      total_tokens: tokens,
      cost_usd: Math.round(cost * 100) / 100,
    };
  });
}
