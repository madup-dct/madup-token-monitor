import type { CodexRateLimitSnapshot } from "@/types/models";

export function buildMockCodexRateLimits(): CodexRateLimitSnapshot[] {
  const now = Date.now();
  return [
    {
      limit_id: "codex",
      limit_name: "Codex",
      plan_type: "pro",
      primary: {
        used_percent: 100,
        window_minutes: 300,
        resets_at: Math.floor((now - 60 * 60_000) / 1000),
      },
      secondary: {
        used_percent: 21,
        window_minutes: 10_080,
        resets_at: Math.floor((now + 6 * 86_400_000) / 1000),
      },
      observed_at: now - 2 * 60_000,
    },
    {
      limit_id: "codex_bengalfox",
      limit_name: "GPT-5.3-Codex-Spark",
      plan_type: "pro",
      primary: null,
      secondary: {
        used_percent: 4,
        window_minutes: 10_080,
        resets_at: Math.floor((now + 7 * 86_400_000) / 1000),
      },
      observed_at: now - 3 * 60_000,
    },
  ];
}
