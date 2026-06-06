import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  useSummary,
  useTimeseries,
  useMyHourly,
  useHeatmap,
  useOAuthUsage,
  useUserMcp,
  useUserPlugins,
  useUserTools,
  refreshOAuthUsage,
} from "@/hooks/useUsage";
import { useAuthUser } from "@/hooks/useAuthUser";
import { usePersistentState } from "@/lib/usePersistentState";
import { PeriodChartCard } from "@/components/dashboard/PeriodChartCard";
import { CarouselCard } from "@/components/dashboard/CarouselCard";
import { HeatMap } from "@/components/HeatMap";
import { RankBarList } from "@/components/ui/RankBarList";
import { MiniBarList } from "@/components/ui/MiniBarList";
import { KpiCard } from "@/components/ui/KpiCard";
import { Sparkline } from "@/components/ui/Sparkline";
import { Select } from "@/components/ui/Select";
import { QuotaSegBar, quotaSignalClass } from "@/components/ui/QuotaSegBar";
import {
  formatTokensCompact,
  formatUSD,
  formatKRW,
  formatPercent,
  formatRelativeTime,
} from "@/lib/format";
import { pctDiff, priorDaysAverage, avgTokensPerActiveDay, projectedMinutesToLimit } from "@/lib/usage-math";
import { prettyToolName } from "@/lib/labels";
import type { Range, Point } from "@/types/models";

const RANGES: { value: Range; label: string }[] = [
  { value: "7d", label: "dashboard.period.week" },
  { value: "30d", label: "dashboard.period.month" },
  { value: "90d", label: "dashboard.period.quarter" },
];

type Granularity = "hourly" | "daily" | "weekly" | "monthly";
const GRANULARITIES: { value: Granularity; label: string }[] = [
  { value: "hourly", label: "시간별" },
  { value: "daily", label: "일자별" },
  { value: "weekly", label: "주별" },
  { value: "monthly", label: "월별" },
];

function localDateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function hourKey(ts: number): string {
  const d = new Date(ts);
  return `${localDateKey(ts)} ${String(d.getHours()).padStart(2, "0")}:00`;
}
function weekStartKey(ts: number): string {
  const d = new Date(ts);
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return localDateKey(d.getTime());
}
function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function yearKey(ts: number): string {
  return String(new Date(ts).getFullYear());
}
function weekLabel(weekStartDate: string): string {
  const d = new Date(weekStartDate + "T00:00:00");
  const month = d.getMonth() + 1;
  const firstOfMonth = new Date(d.getFullYear(), d.getMonth(), 1);
  const firstDow = (firstOfMonth.getDay() + 6) % 7;
  const firstMondayDate = 1 + ((7 - firstDow) % 7);
  const weekIdx = Math.floor((d.getDate() - firstMondayDate) / 7) + 1;
  return `${month}월 ${Math.max(1, weekIdx)}주차`;
}
function monthLabel(mk: string): string {
  const [y, m] = mk.split("-");
  return `${y.slice(2)}년 ${parseInt(m, 10)}월`;
}
function yearLabel(year: string): string {
  return `${year.slice(2)}년`;
}

interface AggRow {
  date: string;
  tokens: number;
  cost: number;
}

function aggregateByPeriod(points: Point[], granularity: Granularity): AggRow[] {
  const keyFn =
    granularity === "hourly"
      ? hourKey
      : granularity === "weekly"
        ? weekStartKey
        : granularity === "monthly"
          ? monthKey
          : localDateKey;
  const map = new Map<string, { tokens: number; cost: number }>();
  for (const p of points) {
    const key = keyFn(p.ts);
    const cur = map.get(key) ?? { tokens: 0, cost: 0 };
    cur.tokens += p.input_tokens + p.output_tokens + (p.cache_read ?? 0) + (p.cache_write ?? 0);
    cur.cost += p.cost_usd;
    map.set(key, cur);
  }
  return Array.from(map.entries())
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function todayLabel(): string {
  const d = new Date();
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} (${days[d.getDay()]})`;
}

const DAILY_CARD_LIMIT: Partial<Record<Range, number>> = {
  "1d": 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

const GAP_FILL_CAP = 400;

/// 빈 시간을 0 으로 채움 — hourly: 오늘 00:00 ~ 현재 시각의 hour 까지 24 이하.
function fillHourlyGaps(rows: AggRow[]): AggRow[] {
  const now = new Date();
  const endHour = now.getHours();
  const map = new Map(rows.map((r) => [r.date, r]));
  const out: AggRow[] = [];
  for (let h = 0; h <= endHour; h++) {
    const d = new Date(now);
    d.setHours(h, 0, 0, 0);
    const key = hourKey(d.getTime());
    out.push(map.get(key) ?? { date: key, tokens: 0, cost: 0 });
  }
  return out;
}

/// 빈 날짜를 0 으로 채움 — daily: 오늘 기준 최근 `days` 일을 연속 생성.
function fillDailyGaps(rows: AggRow[], days: number): AggRow[] {
  if (days <= 0 || days > GAP_FILL_CAP) return rows;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const map = new Map(rows.map((r) => [r.date, r]));
  const out: AggRow[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = localDateKey(d.getTime());
    out.push(map.get(key) ?? { date: key, tokens: 0, cost: 0 });
  }
  return out;
}

/// weekly: 선택 월에 속하는 모든 주(월요일 시작) 를 0 으로 채움.
function fillWeeklyGaps(rows: AggRow[], monthKeyStr: string): AggRow[] {
  if (!monthKeyStr) return rows;
  const [y, m] = monthKeyStr.split("-").map(Number);
  const keysSet = new Set<string>();
  const d = new Date(y, m - 1, 1);
  while (d.getMonth() === m - 1) {
    const wk = weekStartKey(d.getTime());
    if (monthKey(new Date(wk + "T00:00:00").getTime()) === monthKeyStr) {
      keysSet.add(wk);
    }
    d.setDate(d.getDate() + 1);
  }
  const keys = Array.from(keysSet).sort();
  if (keys.length === 0 || keys.length > GAP_FILL_CAP) return rows;
  const map = new Map(rows.map((r) => [r.date, r]));
  return keys.map((k) => map.get(k) ?? { date: k, tokens: 0, cost: 0 });
}

/// monthly: 선택 년의 1월~(올해면 이번 달, 아니면 12월) 을 0 으로 채움.
function fillMonthlyGaps(rows: AggRow[], year: string): AggRow[] {
  if (!year) return rows;
  const now = new Date();
  const maxMonth =
    Number(year) === now.getFullYear() ? now.getMonth() + 1 : 12;
  const keys: string[] = [];
  for (let mo = 1; mo <= maxMonth; mo++) {
    keys.push(`${year}-${String(mo).padStart(2, "0")}`);
  }
  const map = new Map(rows.map((r) => [r.date, r]));
  return keys.map((k) => map.get(k) ?? { date: k, tokens: 0, cost: 0 });
}

export function Dashboard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  // 뷰 토글 — 메뉴 이동/재시작 후에도 마지막 선택값 유지 (usePersistentState).
  const [dailyRange, setDailyRange] = usePersistentState<Range>("madup-token-monitor:dash:dailyRange", "7d");
  const [dailyGranularity, setDailyGranularity] = usePersistentState<Granularity>("madup-token-monitor:dash:dailyGranularity", "daily");
  const [selectedMonth, setSelectedMonth] = useState<string>("");
  const [selectedYear, setSelectedYear] = useState<string>("");
  const [dailyMetric, setDailyMetric] = usePersistentState<"tokens" | "cost">("madup-token-monitor:dash:dailyMetric", "tokens");
  const [dailyView, setDailyView] = usePersistentState<"chart" | "list">("madup-token-monitor:dash:dailyView", "chart");
  const [refreshing, setRefreshing] = useState(false);
  const [lastSync, setLastSync] = useState<Date>(() => new Date());
  const [, setTick] = useState(0);

  // 1초마다 lastSync 상대시간 갱신.
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const { user } = useAuthUser();
  // DB 미보유 차원 — 로컬 유지(세션수/모델/소스비용/히트맵).
  const { data: summary30 } = useSummary("30d");
  const { data: summary7 } = useSummary("7d");
  const { data: summary1 } = useSummary("1d");
  const { data: tsDaily } = useTimeseries(dailyRange);
  // 오늘 KPI 토큰/비용을 DB 기준으로 계산 (다기기 합산). usage_aggregates 본인 전 기기.
  const { data: tsTodayDb } = useTimeseries("1d");
  // 시간별(hourly) 차트 — DB(usage_hourly) 본인 전 기기. 시간별 뷰일 때만 fetch.
  const { data: tsToday } = useMyHourly(dailyGranularity === "hourly");
  const { data: tsMonth } = useTimeseries("30d");
  const { data: tsAll } = useTimeseries("all");
  // DB 미보유 차원 — 로컬 유지(세션수/모델/소스비용/히트맵).
  const { data: heatmap } = useHeatmap(56);
  // MCP / 플러그인 / 도구 — DB(security definer RPC, 본인 uid). 최근 7일.
  const { data: topMcp } = useUserMcp(user?.id ?? null, 7);
  const { data: topPlugins } = useUserPlugins(user?.id ?? null, 7);
  const { data: topTools } = useUserTools(user?.id ?? null, 7);
  const { data: oauthResp } = useOAuthUsage();
  const oauthUsage = oauthResp?.data ?? null;
  const oauthError = oauthResp?.error ?? null;

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["summary"] }),
        qc.invalidateQueries({ queryKey: ["timeseries"] }),
        qc.invalidateQueries({ queryKey: ["heatmap"] }),
        refreshOAuthUsage().then((r) => qc.setQueryData(["oauthUsage"], r)),
      ]);
      setLastSync(new Date());
    } finally {
      setRefreshing(false);
    }
  }

  const availableMonths = useMemo(() => {
    const set = new Set<string>();
    for (const p of tsAll ?? []) set.add(monthKey(p.ts));
    return Array.from(set).sort().reverse();
  }, [tsAll]);
  const availableYears = useMemo(() => {
    const set = new Set<string>();
    for (const p of tsAll ?? []) set.add(yearKey(p.ts));
    return Array.from(set).sort().reverse();
  }, [tsAll]);

  useEffect(() => {
    if (
      dailyGranularity === "weekly" &&
      availableMonths.length > 0 &&
      !availableMonths.includes(selectedMonth)
    ) {
      setSelectedMonth(availableMonths[0]);
    }
    if (
      dailyGranularity === "monthly" &&
      availableYears.length > 0 &&
      !availableYears.includes(selectedYear)
    ) {
      setSelectedYear(availableYears[0]);
    }
  }, [dailyGranularity, availableMonths, availableYears, selectedMonth, selectedYear]);

  const dailyAggregated = useMemo<AggRow[]>(() => {
    if (dailyGranularity === "hourly") {
      return aggregateByPeriod(tsToday ?? [], "hourly");
    }
    if (dailyGranularity === "daily") {
      return aggregateByPeriod(tsDaily ?? [], "daily");
    }
    if (dailyGranularity === "weekly") {
      const all = aggregateByPeriod(tsAll ?? [], "weekly");
      return all.filter(
        (w) => monthKey(new Date(w.date + "T00:00:00").getTime()) === selectedMonth,
      );
    }
    return aggregateByPeriod(tsAll ?? [], "monthly").filter((m) =>
      m.date.startsWith(selectedYear + "-"),
    );
  }, [dailyGranularity, tsDaily, tsToday, tsAll, selectedMonth, selectedYear]);

  const dailyLimit = DAILY_CARD_LIMIT[dailyRange] ?? 30;
  // 빈 시간/날짜/주/월을 0 으로 채워 차트·리스트에서 누락 없이 연속 표시.
  const dailyRows = useMemo<AggRow[]>(() => {
    if (dailyGranularity === "hourly") {
      return fillHourlyGaps(dailyAggregated);
    }
    if (dailyGranularity === "daily") {
      return fillDailyGaps(dailyAggregated, dailyLimit);
    }
    if (dailyGranularity === "weekly") {
      return fillWeeklyGaps(dailyAggregated, selectedMonth);
    }
    return fillMonthlyGaps(dailyAggregated, selectedYear);
  }, [dailyGranularity, dailyAggregated, dailyLimit, selectedMonth, selectedYear]);

  // 7d 합산 / 월간 합산.
  const thisWeek = useMemo(() => calcRange(tsMonth ?? [], "this-week"), [tsMonth]);
  const monthToDate = useMemo(() => calcRange(tsMonth ?? [], "this-month"), [tsMonth]);

  // 7일 sparkline (오늘 포함 마지막 7일).
  const sparkValues = useMemo(() => {
    const agg = aggregateByPeriod(tsMonth ?? [], "daily").slice(-7);
    return agg.map((a) => a.tokens);
  }, [tsMonth]);

  if (!summary1 || !summary7 || !summary30) {
    return (
      <div className="grid place-items-center h-64 text-text-tertiary text-[13px]">
        불러오는 중...
      </div>
    );
  }

  const sumIO = (s: typeof summary1) =>
    s.total_input_tokens + s.total_output_tokens + s.total_cache_read + s.total_cache_write;

  // 오늘 토큰/비용/캐시 — DB(usage_aggregates 본인 전 기기) 기준. 다기기 합산.
  const todayKey = localDateKey(Date.now());
  const todayDb = (tsTodayDb ?? []).filter((p) => localDateKey(p.ts) === todayKey);
  const todayTokens = todayDb.reduce(
    (acc, p) => acc + p.input_tokens + p.output_tokens + (p.cache_read ?? 0) + (p.cache_write ?? 0),
    0,
  );
  const todayCache = todayDb.reduce((acc, p) => acc + (p.cache_read ?? 0) + (p.cache_write ?? 0), 0);
  const todayCost = todayDb.reduce((acc, p) => acc + p.cost_usd, 0);
  // 오늘을 제외한 직전 7일 일평균과 비교 — DB(tsMonth) 기준으로 todayTokens 와 소스 일치.
  // tsMonth 의 마지막 8일에서 오늘을 뺀 직전 7일 토큰 평균.
  const last8Daily = aggregateByPeriod(tsMonth ?? [], "daily").slice(-8);
  const priorWeekTokens = last8Daily
    .filter((d) => d.date !== todayKey)
    .reduce((acc, d) => acc + d.tokens, 0);
  const weekAvgDailyTokens = priorDaysAverage(priorWeekTokens, 0, 7);
  const todayVsWeek = pctDiff(todayTokens, weekAvgDailyTokens);
  // DB 미보유 차원 — 로컬 유지(세션수/요청수). usage_aggregates/hourly 에 session_count 없음.
  const todayMessages = summary1.message_count;
  const todaySessions = summary1.session_count;

  const fiveHour = oauthUsage?.five_hour ?? null;
  const sevenDay = oauthUsage?.seven_day ?? null;
  const sevenDaySonnet = oauthUsage?.seven_day_sonnet ?? null;
  const sevenDayOpus = oauthUsage?.seven_day_opus ?? null;
  const hasRealQuota = fiveHour !== null || sevenDay !== null;
  const sessionUsage = fiveHour
    ? Math.min(1, fiveHour.utilization / 100)
    : Math.min(1, todayTokens / 250_000_000);
  const weeklyUsage = sevenDay
    ? Math.min(1, sevenDay.utilization / 100)
    : Math.min(1, sumIO(summary7) / 1_500_000_000);
  const sessionResetMs = fiveHour
    ? Math.max(0, new Date(fiveHour.resets_at).getTime() - Date.now())
    : 1 * 3600_000 + 3 * 60_000;
  // F1: 5h 한도 도달 예상 — OAuth util + resets_at 만으로 윈도우 평균 페이스 투영.
  const FIVE_HOUR_MS = 5 * 3600_000;
  const sessionElapsedMin = fiveHour
    ? Math.max(0, (FIVE_HOUR_MS - sessionResetMs) / 60_000)
    : 0;
  const sessionProjMin = fiveHour
    ? projectedMinutesToLimit(fiveHour.utilization, sessionElapsedMin)
    : null;
  // 리셋 전에 한도 소진이 예상될 때만 경고 (소진 예상 < 리셋까지 남은 시간).
  const sessionLimitHint =
    fiveHour && fiveHour.utilization >= 100
      ? "한도 도달 — 리셋까지 대기"
      : sessionProjMin !== null && sessionProjMin * 60_000 < sessionResetMs
        ? `현재 페이스로 ~${formatRelativeTime(sessionProjMin * 60_000)} 후 소진`
        : null;
  const weeklyResetMs = sevenDay
    ? Math.max(0, new Date(sevenDay.resets_at).getTime() - Date.now())
    : 1 * 86_400_000 + 14 * 3600_000 + 53 * 60_000;
  const monthlyUsage = Math.min(1, monthToDate.tokens / 15_000_000_000);

  // 활동일 (히트맵 56일 기준) — 히트맵 하단 stat 표시용
  const activeDays = (heatmap ?? []).filter((d) => d.count > 0).length;
  // 평균 일일 토큰 — 분자(30일 토큰)와 분모(최근 30일 활동일)를 같은 창으로 맞춤.
  // 기존 버그: 30일 토큰을 56일 활동일로 나눠 과소 계산됨.
  const cutoff30 = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - 29);
    return localDateKey(d.getTime());
  })();
  const activeDays30 = (heatmap ?? []).filter((d) => d.count > 0 && d.date >= cutoff30).length;
  const avgDailyTokens = avgTokensPerActiveDay(sumIO(summary30), activeDays30);

  // DB 미보유 차원 — 로컬 유지(소스비용 미니바). usage_aggregates 에 source 비용 분해 없음.
  const toolItems = summary7.by_source
    .map((s) => ({ label: s.source, value: s.cost_usd }))
    .sort((a, b) => b.value - a.value);
  // DB 미보유 차원 — 로컬 유지(모델별 토큰 미니바). usage_aggregates 에 model 차원 없음.
  const modelItems = summary7.by_model
    .map((m) => ({
      label: m.model.replace("claude-", ""),
      value: m.input_tokens + m.output_tokens,
    }))
    .sort((a, b) => b.value - a.value);

  function copyDailyToClipboard() {
    const lines = [
      ["Date", dailyMetric === "tokens" ? "Tokens" : "Cost (USD)"].join("\t"),
      ...dailyRows.map((d) =>
        [d.date, dailyMetric === "tokens" ? d.tokens : d.cost.toFixed(4)].join("\t"),
      ),
    ];
    navigator.clipboard.writeText(lines.join("\n")).catch(() => {});
  }

  function exportCsv() {
    const lines = [
      ["Date", "Tokens", "Cost USD"].join(","),
      ...dailyRows.map((d) =>
        [d.date, String(d.tokens), d.cost.toFixed(4)].join(","),
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `madup-token-monitor-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const todayDeltaUp = todayVsWeek >= 0;

  return (
    <div className="px-7 pt-6 pb-8">
      {/* Content head */}
      <div className="flex items-center justify-between gap-4 mb-5">
        <div className="min-w-0">
          <h1 className="text-[22px] font-bold tracking-[-0.01em] text-text-primary">
            {t("nav.dashboard")}
          </h1>
          <p className="num text-[12px] text-text-tertiary mt-1 whitespace-nowrap">
            {todayLabel()} · 마지막 동기화 {formatRelativeShort(Date.now() - lastSync.getTime())} 전
          </p>
        </div>
        <div className="flex gap-2 items-center shrink-0">
          <button onClick={exportCsv} className="mc-btn-outline">
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M8 2v8M5 7l3 3 3-3M2 13h12" />
            </svg>
            내보내기
          </button>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="mc-btn-primary disabled:opacity-70"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={refreshing ? "animate-spin" : undefined}
            >
              <path d="M2 8a6 6 0 0110.3-4.2L14 2v4h-4M14 8a6 6 0 01-10.3 4.2L2 14v-4h4" />
            </svg>
            {refreshing ? "동기화 중…" : "새로고침"}
          </button>
        </div>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-12 gap-4">
        {/* ============ ROW 1: Today (col-8 feature) ============ */}
        <section className="mc-card-feature col-span-8">
          <header className="flex items-center justify-between mb-3.5 gap-3 relative">
            <span className="mc-eyebrow">오늘 · DAILY</span>
            <div className="flex items-center gap-2">
              {weekAvgDailyTokens > 0 && (
                <span className={todayDeltaUp ? "mc-delta-up" : "mc-delta-down"}>
                  {todayDeltaUp ? "+" : "−"}
                  {Math.abs(todayVsWeek * 100).toFixed(0)}% vs 7d 평균
                </span>
              )}
            </div>
          </header>

          <div className="grid grid-cols-[1fr_220px] gap-6 items-start">
            <div className="min-w-0">
              <div className="flex items-baseline gap-2.5">
                <span className="num text-[48px] font-medium leading-none tracking-[-0.02em] text-azure">
                  {formatTokensCompact(todayTokens)}
                </span>
                <span className="text-[13px] text-text-secondary">
                  tokens · <span className="num">{formatTokensCompact(todayCache)}</span> cached
                </span>
              </div>
              <p className="text-[12px] text-text-tertiary mt-2.5 leading-snug">
                입력 + 출력 + 캐시 read/write 합산. Claude API 청구 기준.
              </p>

              <div className="mt-6 grid grid-cols-4 gap-4 pt-5 border-t border-hairline">
                <TodayStat
                  label="비용"
                  value={formatUSD(todayCost)}
                  sub={<span className="num">{formatKRW(todayCost)}</span>}
                  color="amber"
                />
                {/* DB 미보유 차원 — 로컬 유지(요청수/세션수). aggregates/hourly 에 session_count 없음. */}
                <TodayStat
                  label="요청"
                  value={todayMessages.toLocaleString("ko-KR")}
                  sub="건"
                  color="azure"
                />
                <TodayStat
                  label="세션"
                  value={String(todaySessions)}
                  sub="개"
                  color="violet"
                />
                <TodayStat
                  label="활성 사용자"
                  value="1"
                  sub="기기 1대"
                  color="lime"
                />
              </div>
            </div>

            <div
              className="rounded-[10px] border border-hairline p-3.5 pb-2.5"
              style={{ background: "var(--color-surface-2)" }}
            >
              <div className="text-[10px] font-bold tracking-[0.14em] uppercase text-text-tertiary mb-1.5">
                최근 7일 추이
              </div>
              <div className="text-[15px] font-medium text-text-primary mb-1">
                <span className="num">
                  {formatTokensCompact(sparkValues[sparkValues.length - 1] ?? 0)}
                </span>{" "}
                <span className="text-text-tertiary text-[11px]">↘ 오늘</span>
              </div>
              <Sparkline values={sparkValues} width={190} height={84} />
              <div className="flex justify-between num text-[9.5px] text-text-faint mt-1">
                {(() => {
                  const last7 = aggregateByPeriod(tsMonth ?? [], "daily").slice(-7);
                  const first = last7[0]?.date.slice(5) ?? "";
                  const mid = last7[Math.floor(last7.length / 2)]?.date.slice(5) ?? "";
                  const lastEnd = last7[last7.length - 1]?.date.slice(5) ?? "";
                  return (
                    <>
                      <span>{first}</span>
                      <span>{mid}</span>
                      <span>{lastEnd}</span>
                    </>
                  );
                })()}
              </div>
            </div>
          </div>
        </section>

        {/* ============ ROW 1: Quota (col-4) ============ */}
        <section className="mc-card col-span-4">
          <header className="flex items-center justify-between mb-3.5 gap-3 relative">
            <span className="text-[15px] font-semibold text-text-primary tracking-[-0.005em]">
              사용량 한도
            </span>
            <span
              className="inline-flex items-center gap-1.5 h-[22px] px-2.5 rounded-full text-[11px] font-semibold whitespace-nowrap"
              style={{
                background: hasRealQuota ? "var(--color-azure-soft)" : "var(--color-surface-2)",
                color: hasRealQuota ? "var(--color-azure-bright)" : "var(--color-text-tertiary)",
              }}
              title={oauthError ?? undefined}
            >
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{
                  background: hasRealQuota ? "var(--color-azure)" : "var(--color-text-faint)",
                }}
              />
              {hasRealQuota
                ? `OAuth 실시간${oauthUsage?.is_stale ? " (캐시)" : ""}`
                : oauthError
                  ? "오류"
                  : "추정값"}
            </span>
          </header>

          <QuotaRow
            name="세션"
            sub="(5h)"
            meta={`Resets in ${formatRelativeTime(sessionResetMs)}`}
            value={sessionUsage}
            hint={sessionLimitHint}
          />
          <QuotaRow
            name="주간 한도"
            meta={`Resets in ${formatRelativeTime(weeklyResetMs)}`}
            value={weeklyUsage}
          />
          {sevenDaySonnet && (
            <QuotaRow
              name="주간 · Sonnet"
              meta={`Resets in ${formatRelativeTime(Math.max(0, new Date(sevenDaySonnet.resets_at).getTime() - Date.now()))}`}
              value={Math.min(1, sevenDaySonnet.utilization / 100)}
            />
          )}
          {sevenDayOpus && (
            <QuotaRow
              name="주간 · Opus"
              meta={`Resets in ${formatRelativeTime(Math.max(0, new Date(sevenDayOpus.resets_at).getTime() - Date.now()))}`}
              value={Math.min(1, sevenDayOpus.utilization / 100)}
            />
          )}
          <QuotaRow
            name="월간 누적"
            meta={`이번 달 ${new Date().getMonth() + 1}/1~`}
            value={monthlyUsage}
          />

          <div className="mt-5 pt-3.5 border-t border-hairline flex justify-between items-center">
            <span className="text-[11px] text-text-tertiary">
              {formatRelativeShort(Date.now() - lastSync.getTime())} 전 동기화됨
            </span>
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-hairline bg-surface-2 text-text-secondary text-[11.5px] font-medium hover:text-text-primary hover:border-hairline-strong transition-colors disabled:opacity-60"
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                className={refreshing ? "animate-spin" : undefined}
              >
                <path d="M2 8a6 6 0 0110.3-4.2L14 2v4h-4M14 8a6 6 0 01-10.3 4.2L2 14v-4h4" />
              </svg>
              새로고침
            </button>
          </div>
        </section>

        {/* ============ ROW 2: Daily breakdown (col-8) ============ */}
        <PeriodChartCard
          leftHeader={
            <>
              <span className="text-[15px] font-semibold text-text-primary tracking-[-0.005em]">
                기간별 사용량
              </span>
              <Select
                value={dailyGranularity}
                onChange={(v) => setDailyGranularity(v as Granularity)}
                options={GRANULARITIES}
                ariaLabel="단위 선택"
              />
              {dailyGranularity === "hourly" ? null : dailyGranularity === "daily" ? (
                <Select
                  value={dailyRange}
                  onChange={(v) => setDailyRange(v as Range)}
                  options={RANGES.map((r) => ({ value: r.value, label: t(r.label) }))}
                  ariaLabel="기간 선택"
                />
              ) : dailyGranularity === "weekly" ? (
                <Select
                  value={selectedMonth}
                  onChange={setSelectedMonth}
                  options={availableMonths.map((m) => ({ value: m, label: monthLabel(m) }))}
                  ariaLabel="월 선택"
                />
              ) : (
                <Select
                  value={selectedYear}
                  onChange={setSelectedYear}
                  options={availableYears.map((y) => ({ value: y, label: yearLabel(y) }))}
                  ariaLabel="년 선택"
                />
              )}
            </>
          }
          rows={dailyRows}
          metric={dailyMetric}
          onMetricChange={setDailyMetric}
          view={dailyView}
          onViewChange={setDailyView}
          highlightLast={dailyGranularity === "daily" || dailyGranularity === "hourly"}
          chartType={dailyGranularity === "hourly" ? "line" : "auto"}
          labelFormat={(r) =>
            dailyGranularity === "hourly"
              ? `${r.date.slice(11, 13)}시`
              : dailyGranularity === "weekly"
                ? weekLabel(r.date)
                : dailyGranularity === "monthly"
                  ? monthLabel(r.date)
                  : r.date.slice(5)
          }
          onCopy={copyDailyToClipboard}
          emptyText={t("dashboard.empty")}
        />

        {/* ============ ROW 2: Activity carousel (col-4) ============ */}
        <CarouselCard
          persistKey="madup-token-monitor:view:dash:activity"
          className="col-span-4"
          height={320}
          faces={[
            {
              key: "heatmap",
              title: "활동",
              subtitle: "최근 8주",
              node: (
                // DB 미보유 차원 — 로컬 유지(활동 히트맵). 일별 active-day count 는 로컬 전용.
                <div className="h-full">
                  <HeatMap data={heatmap ?? []} weeks={8} />
                  <div className="mt-5 pt-3.5 border-t border-hairline grid grid-cols-2 gap-3.5">
                    <div>
                      <div className="text-[10px] font-bold tracking-[0.14em] uppercase text-text-tertiary mb-1.5">
                        평균 일일 토큰
                      </div>
                      <div className="num text-[20px] font-medium text-text-primary">
                        {formatTokensCompact(avgDailyTokens)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] font-bold tracking-[0.14em] uppercase text-text-tertiary mb-1.5">
                        활동일
                      </div>
                      <div className="num text-[20px] font-medium text-lime">
                        {activeDays}/56
                      </div>
                    </div>
                  </div>
                </div>
              ),
            },
            {
              key: "mcp",
              title: "MCP 사용량",
              subtitle: "최근 7일",
              node: (
                <div className="h-full pr-1">
                  <RankBarList
                    items={(topMcp ?? []).map((m) => ({
                      label: m.mcp_server,
                      value: m.count,
                    }))}
                    formatValue={(v) => v.toLocaleString("ko-KR")}
                    emptyMessage="MCP 사용 기록 없음 (최근 7일)"
                  />
                </div>
              ),
            },
            {
              key: "plugins",
              title: "플러그인 사용량",
              subtitle: "최근 7일",
              node: (
                <div className="h-full pr-1">
                  <RankBarList
                    items={(topPlugins ?? []).map((p) => ({
                      label: p.plugin_id,
                      value: p.count,
                    }))}
                    formatValue={(v) => v.toLocaleString("ko-KR")}
                    emptyMessage="플러그인 사용 기록 없음 (최근 7일)"
                  />
                </div>
              ),
            },
            {
              key: "tools",
              title: "도구 사용량",
              subtitle: "최근 7일",
              node: (
                <div className="h-full pr-1">
                  <RankBarList
                    items={(topTools ?? []).map((toolRow) => ({
                      label: prettyToolName(toolRow.tool_name),
                      value: toolRow.count,
                    }))}
                    formatValue={(v) => v.toLocaleString("ko-KR")}
                    emptyMessage="도구 사용 기록 없음 (최근 7일)"
                  />
                </div>
              ),
            },
          ]}
        />

        {/* ============ ROW 3: 4 col-3 cards ============ */}
        <MiniStatCard
          eyebrow="이번 주 · 월~일"
          value={formatTokensCompact(thisWeek.tokens)}
          suffix="tokens"
          subline={
            <>
              <span className="num text-text-secondary">
                {formatTokensCompact(thisWeek.cache)}
              </span>{" "}
              cached · {thisWeek.days}일 활동
            </>
          }
          foot={[
            { label: "비용", value: formatUSD(thisWeek.cost) },
            {
              label: "입력",
              value: formatPercent(thisWeek.totalInput / Math.max(1, thisWeek.tokens)),
            },
          ]}
        />

        <MiniStatCard
          eyebrow={`이번 달 · ${new Date().getMonth() + 1}월 1일~`}
          value={formatTokensCompact(monthToDate.tokens)}
          suffix="tokens"
          subline={
            <>
              <span className="num text-text-secondary">
                {formatTokensCompact(monthToDate.cache)}
              </span>{" "}
              cached · {monthToDate.days}일 활동
            </>
          }
          foot={[
            { label: "비용", value: formatUSD(monthToDate.cost) },
            {
              label: "입력",
              value: formatPercent(monthToDate.totalInput / Math.max(1, monthToDate.tokens)),
            },
          ]}
        />

        <section className="mc-card col-span-3">
          <header className="mb-3.5">
            <span className="mc-eyebrow">도구별 비용 · 7일</span>
          </header>
          <MiniBarList
            items={toolItems}
            formatValue={(v) => formatUSD(v)}
            emphasizeMax="amber"
          />
        </section>

        <section className="mc-card col-span-3">
          <header className="mb-3.5">
            <span className="mc-eyebrow">모델별 토큰 · 7일</span>
          </header>
          <MiniBarList
            items={modelItems}
            formatValue={(v) => formatTokensCompact(v)}
            emphasizeMax="azure"
          />
        </section>
      </div>
    </div>
  );
}

// =============================================================================
// Helpers
// =============================================================================

function calcRange(
  ts: Point[],
  kind: "this-week" | "this-month",
): { tokens: number; cost: number; cache: number; days: number; totalInput: number } {
  if (ts.length === 0)
    return { tokens: 0, cost: 0, cache: 0, days: 0, totalInput: 0 };
  const now = new Date();
  let start: number;
  let end: number;
  if (kind === "this-week") {
    const dow = (now.getDay() + 6) % 7;
    const monday = new Date(now);
    monday.setDate(now.getDate() - dow);
    monday.setHours(0, 0, 0, 0);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);
    start = monday.getTime();
    end = sunday.getTime();
  } else {
    start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    end = Date.now();
  }
  const filtered = ts.filter((p) => p.ts >= start && p.ts <= end);
  const dayKeys = new Set(filtered.map((p) => localDateKey(p.ts)));
  let tokens = 0,
    cost = 0,
    cache = 0,
    totalInput = 0;
  for (const p of filtered) {
    const cr = p.cache_read ?? 0;
    const cw = p.cache_write ?? 0;
    tokens += p.input_tokens + p.output_tokens + cr + cw;
    totalInput += p.input_tokens;
    cost += p.cost_usd;
    cache += cr + cw;
  }
  return { tokens, cost, cache, days: dayKeys.size, totalInput };
}

function formatRelativeShort(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}초`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}분`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3600_000)}시간`;
  return `${Math.floor(ms / 86_400_000)}일`;
}

interface TodayStatProps {
  label: string;
  value: string;
  sub: React.ReactNode;
  color: "amber" | "azure" | "violet" | "lime";
}
function TodayStat({ label, value, sub, color }: TodayStatProps) {
  const colorClass = {
    amber: "text-amber",
    azure: "text-azure",
    violet: "text-violet",
    lime: "text-lime",
  }[color];
  return (
    <div>
      <div className="text-[10.5px] font-bold tracking-[0.14em] uppercase text-text-tertiary mb-2 whitespace-nowrap">
        {label}
      </div>
      <div className={`num text-[22px] font-medium leading-tight tracking-[-0.01em] ${colorClass}`}>
        {value}
      </div>
      <div className="text-[11px] text-text-tertiary mt-1">{sub}</div>
    </div>
  );
}

interface QuotaRowProps {
  name: string;
  sub?: string;
  meta: string;
  value: number;
  hint?: string | null;
}
function QuotaRow({ name, sub, meta, value, hint }: QuotaRowProps) {
  const pct = (value * 100).toFixed(1);
  return (
    <div className="mt-4 first:mt-1">
      <div className="flex items-center justify-between mb-2 gap-3">
        <div className="text-[13px] font-semibold text-text-primary whitespace-nowrap">
          {name}
          {sub && (
            <span className="font-normal text-text-tertiary text-[11px] ml-1.5">
              {sub}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2.5 text-[11px] text-text-tertiary whitespace-nowrap shrink-0">
          <span>{meta}</span>
          <span className={`num text-[13px] font-medium ${quotaSignalClass(value)}`}>
            {pct}%
          </span>
        </div>
      </div>
      <QuotaSegBar value={value} />
      {hint ? (
        // hint 는 항상 주의 메시지(조기 소진/한도 도달)이므로 amber 고정.
        // (사용률 기반 색을 쓰면 낮은 사용률 초반 경고가 lime 으로 나와 의미 모순)
        <div className="mt-1.5 text-[10.5px] font-medium text-amber">{hint}</div>
      ) : null}
    </div>
  );
}

interface MiniStatProps {
  eyebrow: string;
  value: string;
  suffix: string;
  subline: React.ReactNode;
  foot: { label: string; value: string }[];
}
function MiniStatCard({ eyebrow, value, suffix, subline, foot }: MiniStatProps) {
  return (
    <section className="mc-card col-span-3">
      <header className="mb-1">
        <span className="mc-eyebrow">{eyebrow}</span>
      </header>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="num text-[36px] font-medium leading-none tracking-[-0.02em] text-azure">
          {value}
        </span>
        <span className="text-[12px] text-text-secondary">{suffix}</span>
      </div>
      <div className="text-[11px] text-text-tertiary mt-1.5">{subline}</div>
      <div className="mt-3.5 pt-3 border-t border-hairline flex gap-3.5 text-[11px] text-text-tertiary">
        {foot.map((f) => (
          <span key={f.label}>
            <strong className="num text-text-secondary font-semibold mr-1">
              {f.value}
            </strong>
            {f.label}
          </span>
        ))}
      </div>
    </section>
  );
}


// KpiCard import 사용처 없는 경우 빈 wrapper 임포트로 만들지 않게 leave-out:
// (실제로 KpiCard 는 future use 를 위해 export 만 됨.)
export const __kpi_card_in_use = KpiCard;
