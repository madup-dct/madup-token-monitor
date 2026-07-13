import type { PeriodRow } from "@/components/dashboard/PeriodChartCard";
import type { UserDailyAggregate, UserHourlyAggregate } from "@/lib/user-dashboard-data";
import { matchesUsageScope, type UsageScope } from "@/lib/usage-sources";
import { pctDiff, priorDaysAverage } from "@/lib/usage-math";

export type UserUsageGranularity = "hourly" | "daily" | "weekly" | "monthly";
export type UserUsageDailyRange = 7 | 30 | 90;

export interface UserDashboardUsageInput {
  daily: readonly UserDailyAggregate[];
  hourly: readonly UserHourlyAggregate[];
  scope: UsageScope;
  granularity: UserUsageGranularity;
  dailyRange: UserUsageDailyRange;
  nowMs: number;
}

interface RangeSummary {
  tokens: number;
  cost: number;
  days: number;
}

export interface UserDashboardUsage {
  rows: PeriodRow[];
  labelFormat: (row: PeriodRow) => string;
  periodLabel: string;
  kpi: { tokens: number; cost: number; activeDays: number };
  avgDaily: number;
  heatmapData: { date: string; count: number; cost_usd: number }[];
  todayTokens: number;
  todayCost: number;
  last7: PeriodRow[];
  sparkValues: number[];
  weekAvgDailyTokens: number;
  todayVsWeek: number;
  thisWeek: RangeSummary;
  thisMonth: RangeSummary;
  thisMonthLabel: string;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const KST_OFFSET_MS = 9 * HOUR_MS;

function padded(value: number): string {
  return String(value).padStart(2, "0");
}

function kstDateKey(timestamp: number): string {
  const date = new Date(timestamp + KST_OFFSET_MS);
  return `${date.getUTCFullYear()}-${padded(date.getUTCMonth() + 1)}-${padded(date.getUTCDate())}`;
}

function kstHourKey(timestamp: number): string {
  const date = new Date(timestamp + KST_OFFSET_MS);
  return `${kstDateKey(timestamp)} ${padded(date.getUTCHours())}:00`;
}

function dateKeyTimestamp(dateKey: string): number {
  return Date.parse(`${dateKey}T00:00:00+09:00`);
}

function shiftedDateKey(dateKey: string, days: number): string {
  return kstDateKey(dateKeyTimestamp(dateKey) + days * DAY_MS);
}

function weekStartKey(dateKey: string): string {
  const date = new Date(dateKeyTimestamp(dateKey) + KST_OFFSET_MS);
  const offset = (date.getUTCDay() + 6) % 7;
  return shiftedDateKey(dateKey, -offset);
}

function monthKey(dateKey: string): string {
  return dateKey.slice(0, 7);
}

function aggregateDaily(
  rows: readonly UserDailyAggregate[],
  keyForDate: (date: string) => string
): PeriodRow[] {
  const totals = new Map<string, { tokens: number; cost: number }>();
  for (const row of rows) {
    const key = keyForDate(row.date);
    const current = totals.get(key) ?? { tokens: 0, cost: 0 };
    current.tokens += Number(row.total_tokens);
    current.cost += Number(row.total_cost_usd);
    totals.set(key, current);
  }
  return [...totals.entries()]
    .map(([date, values]) => ({ date, ...values }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

function aggregateHourly(rows: readonly UserHourlyAggregate[]): PeriodRow[] {
  const totals = new Map<string, { tokens: number; cost: number }>();
  for (const row of rows) {
    const key = kstHourKey(Date.parse(row.hour_utc));
    const current = totals.get(key) ?? { tokens: 0, cost: 0 };
    current.tokens +=
      Number(row.input_tokens) +
      Number(row.output_tokens) +
      Number(row.cache_read) +
      Number(row.cache_write);
    current.cost += Number(row.cost_usd);
    totals.set(key, current);
  }
  return [...totals.entries()]
    .map(([date, values]) => ({ date, ...values }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

function fillRows(keys: readonly string[], rows: readonly PeriodRow[]): PeriodRow[] {
  const byKey = new Map(rows.map((row) => [row.date, row]));
  return keys.map((date) => byKey.get(date) ?? { date, tokens: 0, cost: 0 });
}

function dailyKeys(nowMs: number, count: number): string[] {
  const today = kstDateKey(nowMs);
  return Array.from({ length: count }, (_, index) => shiftedDateKey(today, index - count + 1));
}

function hourlyKeys(nowMs: number, count: number): string[] {
  const currentHour = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  return Array.from({ length: count }, (_, index) =>
    kstHourKey(currentHour + (index - count + 1) * HOUR_MS)
  );
}

function weeklyKeys(nowMs: number, count: number): string[] {
  const thisWeek = weekStartKey(kstDateKey(nowMs));
  return Array.from({ length: count }, (_, index) =>
    shiftedDateKey(thisWeek, (index - count + 1) * 7)
  );
}

function monthlyKeys(nowMs: number, count: number): string[] {
  const shiftedNow = new Date(nowMs + KST_OFFSET_MS);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(
      Date.UTC(shiftedNow.getUTCFullYear(), shiftedNow.getUTCMonth() + index - count + 1, 1)
    );
    return `${date.getUTCFullYear()}-${padded(date.getUTCMonth() + 1)}`;
  });
}

function summarizeRange(
  rows: readonly UserDailyAggregate[],
  start: string,
  end: string
): RangeSummary {
  const activeDates = new Set<string>();
  let tokens = 0;
  let cost = 0;
  for (const row of rows) {
    if (row.date < start || row.date > end) continue;
    tokens += Number(row.total_tokens);
    cost += Number(row.total_cost_usd);
    if (Number(row.total_tokens) > 0 || Number(row.total_cost_usd) > 0) activeDates.add(row.date);
  }
  return { tokens, cost, days: activeDates.size };
}

function buildPeriodRows(
  granularity: UserUsageGranularity,
  dailyRange: UserUsageDailyRange,
  daily: readonly UserDailyAggregate[],
  hourly: readonly UserHourlyAggregate[],
  nowMs: number
): Pick<UserDashboardUsage, "rows" | "labelFormat" | "periodLabel"> {
  if (granularity === "hourly") {
    return {
      rows: fillRows(hourlyKeys(nowMs, 24), aggregateHourly(hourly)),
      labelFormat: (row) => `${row.date.slice(11, 13)}시`,
      periodLabel: "최근 24시간 · 시간별",
    };
  }
  if (granularity === "weekly") {
    return {
      rows: fillRows(weeklyKeys(nowMs, 12), aggregateDaily(daily, weekStartKey)),
      labelFormat: (row) => `${Number(row.date.slice(5, 7))}/${Number(row.date.slice(8, 10))}~`,
      periodLabel: "최근 12주 · 주별",
    };
  }
  if (granularity === "monthly") {
    return {
      rows: fillRows(monthlyKeys(nowMs, 12), aggregateDaily(daily, monthKey)),
      labelFormat: (row) => `${row.date.slice(2, 4)}년 ${Number(row.date.slice(5, 7))}월`,
      periodLabel: "최근 12개월 · 월별",
    };
  }
  return {
    rows: fillRows(
      dailyKeys(nowMs, dailyRange),
      aggregateDaily(daily, (date) => date)
    ),
    labelFormat: (row) => row.date.slice(5),
    periodLabel: `최근 ${dailyRange}일 · 일자별`,
  };
}

export function buildUserDashboardUsage(input: UserDashboardUsageInput): UserDashboardUsage {
  const daily = input.daily.filter((row) => matchesUsageScope(row.source, input.scope));
  const hourly = input.hourly.filter((row) => matchesUsageScope(row.source, input.scope));
  const dailyByDay = aggregateDaily(daily, (date) => date);
  const todayKey = kstDateKey(input.nowMs);
  const kpiRange = summarizeRange(daily, shiftedDateKey(todayKey, -29), todayKey);
  const today = dailyByDay.find((row) => row.date === todayKey);
  const last7 = fillRows(dailyKeys(input.nowMs, 7), dailyByDay);
  const prior7Keys = Array.from({ length: 7 }, (_, index) => shiftedDateKey(todayKey, index - 7));
  const priorTotal = fillRows(prior7Keys, dailyByDay).reduce((total, row) => total + row.tokens, 0);
  const weekAvgDailyTokens = priorDaysAverage(priorTotal, 0, 7);
  const period = buildPeriodRows(input.granularity, input.dailyRange, daily, hourly, input.nowMs);
  const kpi = { tokens: kpiRange.tokens, cost: kpiRange.cost, activeDays: kpiRange.days };

  return {
    ...period,
    kpi,
    avgDaily: kpi.activeDays > 0 ? kpi.tokens / kpi.activeDays : 0,
    heatmapData: dailyByDay.map((row) => ({
      date: row.date,
      count: Math.round(row.tokens),
      cost_usd: row.cost,
    })),
    todayTokens: today?.tokens ?? 0,
    todayCost: today?.cost ?? 0,
    last7,
    sparkValues: last7.map((row) => row.tokens),
    weekAvgDailyTokens,
    todayVsWeek: pctDiff(today?.tokens ?? 0, weekAvgDailyTokens),
    thisWeek: summarizeRange(daily, weekStartKey(todayKey), todayKey),
    thisMonth: summarizeRange(daily, `${monthKey(todayKey)}-01`, todayKey),
    thisMonthLabel: `${Number(todayKey.slice(5, 7))}월 1일~`,
  };
}
