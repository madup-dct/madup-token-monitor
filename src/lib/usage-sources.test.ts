import { describe, expect, it } from "vitest";
import type { Summary } from "@/types/models";
import {
  isUsageScope,
  mergeDayCounts,
  mergeSummaries,
  selectForScope,
  sourcesForScope,
} from "./usage-sources";

const CLAUDE_SUMMARY: Summary = {
  total_input_tokens: 100,
  total_output_tokens: 20,
  total_cache_read: 300,
  total_cache_write: 40,
  total_cost_usd: 1.5,
  total_cost_krw: 2_070,
  message_count: 2,
  session_count: 1,
  by_source: [{ source: "claude", input_tokens: 100, output_tokens: 20, cost_usd: 1.5 }],
  by_model: [
    {
      model: "claude-opus-4-7",
      input_tokens: 100,
      output_tokens: 20,
      cache_read: 300,
      cache_write: 40,
      cost_usd: 1.5,
    },
  ],
};

const CODEX_SUMMARY: Summary = {
  total_input_tokens: 50,
  total_output_tokens: 10,
  total_cache_read: 150,
  total_cache_write: 0,
  total_cost_usd: 0.5,
  total_cost_krw: 690,
  message_count: 3,
  session_count: 2,
  by_source: [{ source: "codex", input_tokens: 50, output_tokens: 10, cost_usd: 0.5 }],
  by_model: [
    {
      model: "gpt-5.6-sol",
      input_tokens: 50,
      output_tokens: 10,
      cache_read: 150,
      cache_write: 0,
      cost_usd: 0.5,
    },
  ],
};

describe("sourcesForScope", () => {
  it("통합은 Claude와 Codex만 포함한다", () => {
    expect(sourcesForScope("combined")).toEqual(["claude", "codex"]);
  });

  it("개별 scope는 해당 source 하나만 포함한다", () => {
    expect(sourcesForScope("claude")).toEqual(["claude"]);
    expect(sourcesForScope("codex")).toEqual(["codex"]);
  });
});

describe("isUsageScope", () => {
  it("저장 가능한 세 scope만 허용한다", () => {
    expect(["combined", "claude", "codex"].every(isUsageScope)).toBe(true);
    expect(isUsageScope("opencode")).toBe(false);
    expect(isUsageScope(null)).toBe(false);
  });
});

describe("mergeSummaries", () => {
  it("Claude와 Codex 합계와 breakdown을 손실 없이 합친다", () => {
    const merged = mergeSummaries([CLAUDE_SUMMARY, CODEX_SUMMARY]);

    expect(merged).toMatchObject({
      total_input_tokens: 150,
      total_output_tokens: 30,
      total_cache_read: 450,
      total_cache_write: 40,
      total_cost_usd: 2,
      total_cost_krw: 2_760,
      message_count: 5,
      session_count: 3,
    });
    expect(merged.by_source.map((item) => item.source)).toEqual(["claude", "codex"]);
    expect(merged.by_model.map((item) => item.model)).toEqual(["claude-opus-4-7", "gpt-5.6-sol"]);
  });
});

describe("selectForScope", () => {
  it("통합은 두 source를 결합하고 개별 scope는 하나만 고른다", () => {
    const pair = { claude: ["claude"], codex: ["codex"] };

    expect(selectForScope("combined", pair, (items) => items.flat())).toEqual(["claude", "codex"]);
    expect(selectForScope("claude", pair, (items) => items.flat())).toEqual(["claude"]);
    expect(selectForScope("codex", pair, (items) => items.flat())).toEqual(["codex"]);
  });
});

describe("mergeDayCounts", () => {
  it("같은 KST 날짜의 Claude와 Codex 활동량과 비용을 합친다", () => {
    expect(
      mergeDayCounts([
        [{ date: "2026-07-13", count: 2, cost_usd: 1.25 }],
        [
          { date: "2026-07-12", count: 1, cost_usd: 0.5 },
          { date: "2026-07-13", count: 3, cost_usd: 0.75 },
        ],
      ])
    ).toEqual([
      { date: "2026-07-12", count: 1, cost_usd: 0.5 },
      { date: "2026-07-13", count: 5, cost_usd: 2 },
    ]);
  });
});
