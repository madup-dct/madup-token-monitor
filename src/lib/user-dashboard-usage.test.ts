import { describe, expect, it } from "vitest";
import type { UserDailyAggregate, UserHourlyAggregate } from "@/lib/user-dashboard-data";
import { buildUserDashboardUsage } from "./user-dashboard-usage";

const NOW = Date.parse("2026-07-13T03:30:00Z");

const daily: UserDailyAggregate[] = [
  {
    date: "2026-07-13",
    source: "claude",
    total_input: 20,
    total_output: 10,
    total_tokens: 100,
    total_cost_usd: 1,
  },
  {
    date: "2026-07-13",
    source: "claude-code",
    total_input: 5,
    total_output: 5,
    total_tokens: 25,
    total_cost_usd: 0.25,
  },
  {
    date: "2026-07-13",
    source: "codex",
    total_input: 10,
    total_output: 5,
    total_tokens: 50,
    total_cost_usd: 0.5,
  },
  {
    date: "2026-07-13",
    source: "opencode",
    total_input: 30,
    total_output: 10,
    total_tokens: 400,
    total_cost_usd: 4,
  },
];

const hourly: UserHourlyAggregate[] = [
  {
    hour_utc: "2026-07-12T15:00:00Z",
    source: "claude",
    model: "claude",
    input_tokens: 2,
    output_tokens: 1,
    cache_read: 7,
    cache_write: 0,
    cost_usd: 0.1,
    request_count: 1,
  },
  {
    hour_utc: "2026-07-12T15:00:00Z",
    source: "codex",
    model: "codex",
    input_tokens: 1,
    output_tokens: 1,
    cache_read: 8,
    cache_write: 0,
    cost_usd: 0.2,
    request_count: 1,
  },
  {
    hour_utc: "2026-07-12T15:00:00Z",
    source: "opencode",
    model: "other",
    input_tokens: 100,
    output_tokens: 100,
    cache_read: 100,
    cache_write: 100,
    cost_usd: 5,
    request_count: 1,
  },
];

describe("buildUserDashboardUsage", () => {
  it("통합 지표 전체에서 Claude 계열과 Codex만 합산한다", () => {
    const result = buildUserDashboardUsage({
      daily,
      hourly,
      scope: "combined",
      granularity: "daily",
      dailyRange: 7,
      nowMs: NOW,
    });

    expect(result.todayTokens).toBe(175);
    expect(result.kpi).toEqual({ tokens: 175, cost: 1.75, activeDays: 1 });
    expect(result.heatmapData[result.heatmapData.length - 1]?.count).toBe(175);
    expect(result.thisWeek.tokens).toBe(175);
    expect(result.thisMonth.tokens).toBe(175);
    expect(result.rows[result.rows.length - 1]?.tokens).toBe(175);
  });

  it("Claude와 Codex scope를 독립적으로 계산한다", () => {
    const claude = buildUserDashboardUsage({
      daily,
      hourly,
      scope: "claude",
      granularity: "daily",
      dailyRange: 7,
      nowMs: NOW,
    });
    const codex = buildUserDashboardUsage({
      daily,
      hourly,
      scope: "codex",
      granularity: "daily",
      dailyRange: 7,
      nowMs: NOW,
    });

    expect(claude.todayTokens).toBe(125);
    expect(codex.todayTokens).toBe(50);
  });

  it("UTC 시간 버킷을 KST 정시로 바꾸고 선택 source만 표시한다", () => {
    const result = buildUserDashboardUsage({
      daily,
      hourly,
      scope: "combined",
      granularity: "hourly",
      dailyRange: 7,
      nowMs: NOW,
    });
    const midnight = result.rows.find((row) => row.date === "2026-07-13 00:00");

    expect(midnight?.tokens).toBe(20);
    expect(midnight?.cost).toBeCloseTo(0.3);
    expect(result.labelFormat(midnight!)).toBe("00시");
  });

  it("직전 7일 평균은 오래된 활동일이 아니라 7개 달력일만 사용한다", () => {
    const result = buildUserDashboardUsage({
      daily: [
        {
          date: "2026-06-01",
          source: "codex",
          total_input: 1,
          total_output: 1,
          total_tokens: 7_000,
          total_cost_usd: 1,
        },
        {
          date: "2026-07-12",
          source: "codex",
          total_input: 1,
          total_output: 1,
          total_tokens: 70,
          total_cost_usd: 1,
        },
      ],
      hourly: [],
      scope: "codex",
      granularity: "daily",
      dailyRange: 7,
      nowMs: NOW,
    });

    expect(result.weekAvgDailyTokens).toBe(10);
  });
});
