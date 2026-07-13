import type { DayCount, ModelSummary, SourceSummary, Summary } from "@/types/models";

export const USAGE_SCOPE_OPTIONS = [
  { value: "combined", label: "통합" },
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
] as const;

export type UsageScope = (typeof USAGE_SCOPE_OPTIONS)[number]["value"];
export type UsageSource = "claude" | "claude-code" | "codex";

export function isUsageScope(value: unknown): value is UsageScope {
  return USAGE_SCOPE_OPTIONS.some((option) => option.value === value);
}

export interface SourcePair<T> {
  readonly claude: T;
  readonly codex: T;
}

export function sourcesForScope(scope: UsageScope): readonly UsageSource[] {
  switch (scope) {
    case "combined":
      return ["claude", "claude-code", "codex"];
    case "claude":
      return ["claude", "claude-code"];
    case "codex":
      return ["codex"];
    default:
      return assertNever(scope);
  }
}

export function matchesUsageScope(source: string, scope: UsageScope): boolean {
  const provider =
    source === "codex"
      ? "codex"
      : source === "claude" || source === "claude-code"
        ? "claude"
        : null;
  return provider !== null && (scope === "combined" || provider === scope);
}

export function selectForScope<T>(
  scope: UsageScope,
  pair: SourcePair<T>,
  combine: (values: readonly [T, T]) => T
): T {
  switch (scope) {
    case "combined":
      return combine([pair.claude, pair.codex]);
    case "claude":
      return pair.claude;
    case "codex":
      return pair.codex;
    default:
      return assertNever(scope);
  }
}

export function mergeSummaries(summaries: readonly Summary[]): Summary {
  const sourceMap = new Map<string, SourceSummary>();
  const modelMap = new Map<string, ModelSummary>();
  const totals = summaries.reduce(
    (accumulator, summary) => {
      accumulator.total_input_tokens += summary.total_input_tokens;
      accumulator.total_output_tokens += summary.total_output_tokens;
      accumulator.total_cache_read += summary.total_cache_read;
      accumulator.total_cache_write += summary.total_cache_write;
      accumulator.total_cost_usd += summary.total_cost_usd;
      accumulator.total_cost_krw += summary.total_cost_krw;
      accumulator.message_count += summary.message_count;
      accumulator.session_count += summary.session_count;

      for (const item of summary.by_source) {
        const current = sourceMap.get(item.source);
        sourceMap.set(item.source, {
          source: item.source,
          input_tokens: (current?.input_tokens ?? 0) + item.input_tokens,
          output_tokens: (current?.output_tokens ?? 0) + item.output_tokens,
          cost_usd: (current?.cost_usd ?? 0) + item.cost_usd,
        });
      }
      for (const item of summary.by_model) {
        const current = modelMap.get(item.model);
        modelMap.set(item.model, {
          model: item.model,
          input_tokens: (current?.input_tokens ?? 0) + item.input_tokens,
          output_tokens: (current?.output_tokens ?? 0) + item.output_tokens,
          cache_read: (current?.cache_read ?? 0) + item.cache_read,
          cache_write: (current?.cache_write ?? 0) + item.cache_write,
          cost_usd: (current?.cost_usd ?? 0) + item.cost_usd,
        });
      }
      return accumulator;
    },
    {
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_read: 0,
      total_cache_write: 0,
      total_cost_usd: 0,
      total_cost_krw: 0,
      message_count: 0,
      session_count: 0,
    }
  );

  return {
    ...totals,
    by_source: [...sourceMap.values()],
    by_model: [...modelMap.values()],
  };
}

export function mergeDayCounts(groups: readonly DayCount[][]): DayCount[] {
  const totals = new Map<string, DayCount>();
  for (const group of groups) {
    for (const day of group) {
      const current = totals.get(day.date);
      totals.set(day.date, {
        date: day.date,
        count: (current?.count ?? 0) + day.count,
        cost_usd: (current?.cost_usd ?? 0) + day.cost_usd,
      });
    }
  }
  return [...totals.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected usage scope: ${String(value)}`);
}
