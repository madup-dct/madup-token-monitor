import { useMyHourly, useSummary, useTimeseries } from "@/hooks/useUsage";
import { mergeSummaries, type UsageScope } from "@/lib/usage-sources";
import type { Point, Range, Summary } from "@/types/models";

const COMBINED_SOURCES = ["claude", "codex"] as const;
const CLAUDE_SOURCE = ["claude"] as const;
const CODEX_SOURCE = ["codex"] as const;

interface SummaryPair {
  readonly claude: Summary | undefined;
  readonly codex: Summary | undefined;
}

interface PointSet {
  readonly combined: Point[] | undefined;
  readonly claude: Point[] | undefined;
  readonly codex: Point[] | undefined;
}

interface ReadyPointSet {
  readonly combined: Point[];
  readonly claude: Point[];
  readonly codex: Point[];
}

interface DashboardUsage {
  readonly summary1: Summary | undefined;
  readonly summary7: Summary | undefined;
  readonly summary30: Summary | undefined;
  readonly tsDaily: Point[] | undefined;
  readonly tsTodayDb: Point[] | undefined;
  readonly tsToday: Point[] | undefined;
  readonly tsMonth: Point[] | undefined;
  readonly tsAll: Point[] | undefined;
  readonly combinedTsTodayDb: Point[] | undefined;
  readonly combinedTs7: Point[] | undefined;
  readonly combinedTsMonth: Point[] | undefined;
}

export function useDashboardUsage(
  scope: UsageScope,
  dailyRange: Range,
  hourlyEnabled: boolean
): DashboardUsage {
  const summary1 = useSummaryPair("1d");
  const summary7 = useSummaryPair("7d");
  const summary30 = useSummaryPair("30d");
  const tsDaily = useTimeseriesSet(dailyRange);
  const tsTodayDb = useTimeseriesSet("1d");
  const combinedTs7 = useTimeseries("7d", COMBINED_SOURCES).data;
  const tsMonth = useTimeseriesSet("30d");
  const tsAll = useTimeseriesSet("all");
  const tsToday = useHourlySet(hourlyEnabled);
  const ready =
    isPointSetReady(tsDaily) &&
    isPointSetReady(tsTodayDb) &&
    combinedTs7 !== undefined &&
    isPointSetReady(tsMonth) &&
    isPointSetReady(tsAll) &&
    (!hourlyEnabled || isPointSetReady(tsToday));

  return {
    summary1: ready ? selectSummary(scope, summary1) : undefined,
    summary7: ready ? selectSummary(scope, summary7) : undefined,
    summary30: ready ? selectSummary(scope, summary30) : undefined,
    tsDaily: ready ? tsDaily[scope] : undefined,
    tsTodayDb: ready ? tsTodayDb[scope] : undefined,
    tsToday: ready ? tsToday[scope] : undefined,
    tsMonth: ready ? tsMonth[scope] : undefined,
    tsAll: ready ? tsAll[scope] : undefined,
    combinedTsTodayDb: ready ? tsTodayDb.combined : undefined,
    combinedTs7: ready ? combinedTs7 : undefined,
    combinedTsMonth: ready ? tsMonth.combined : undefined,
  };
}

function useTimeseriesSet(range: Range): PointSet {
  return {
    combined: useTimeseries(range, COMBINED_SOURCES).data,
    claude: useTimeseries(range, CLAUDE_SOURCE).data,
    codex: useTimeseries(range, CODEX_SOURCE).data,
  };
}

function useHourlySet(enabled: boolean): PointSet {
  return {
    combined: useMyHourly(enabled, COMBINED_SOURCES).data,
    claude: useMyHourly(enabled, CLAUDE_SOURCE).data,
    codex: useMyHourly(enabled, CODEX_SOURCE).data,
  };
}

function useSummaryPair(range: Range): SummaryPair {
  return {
    claude: useSummary(range, CLAUDE_SOURCE).data,
    codex: useSummary(range, CODEX_SOURCE).data,
  };
}

function selectSummary(scope: UsageScope, pair: SummaryPair): Summary | undefined {
  return scope === "combined" ? combineSummaryPair(pair) : pair[scope];
}

function combineSummaryPair(pair: SummaryPair): Summary | undefined {
  return pair.claude && pair.codex ? mergeSummaries([pair.claude, pair.codex]) : undefined;
}

function isPointSetReady(values: PointSet): values is ReadyPointSet {
  return values.combined !== undefined && values.claude !== undefined && values.codex !== undefined;
}
