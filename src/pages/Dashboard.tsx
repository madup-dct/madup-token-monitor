import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  useHeatmap,
  useOAuthUsage,
  useCodexRateLimits,
  useUserMcp,
  useUserPlugins,
  useUserTools,
  useMyDeviceCount,
  refreshOAuthUsage,
} from "@/hooks/useUsage";
import { useDashboardUsage } from "@/hooks/useDashboardUsage";
import { useAuthUser } from "@/hooks/useAuthUser";
import { usePersistentState } from "@/lib/usePersistentState";
import { PeriodChartCard } from "@/components/dashboard/PeriodChartCard";
import { UsageSourceCarousel } from "@/components/dashboard/UsageSourceCarousel";
import { CarouselCard } from "@/components/dashboard/CarouselCard";
import { TodayStat } from "@/components/dashboard/TodayStat";
import { MiniStatCard } from "@/components/dashboard/MiniStatCard";
import { HeatMap } from "@/components/HeatMap";
import { RankBarList } from "@/components/ui/RankBarList";
import { MiniBarList } from "@/components/ui/MiniBarList";
import { Sparkline } from "@/components/ui/Sparkline";
import { Select } from "@/components/ui/Select";
import { CarouselControls } from "@/components/ui/CarouselControls";
import { formatTokensCompact, formatUSD, formatKRW, formatPercent } from "@/lib/format";
import { pctDiff, priorDaysAverage, avgTokensPerActiveDay } from "@/lib/usage-math";
import { prettyPluginId, prettyToolName } from "@/lib/labels";
import {
  isUsageScope,
  sourcesForScope,
  USAGE_SCOPE_OPTIONS,
  type UsageScope,
} from "@/lib/usage-sources";
import type { Range, Point, Summary } from "@/types/models";

const RANGES: { value: Range; label: string }[] = [
  { value: "7d", label: "dashboard.period.week" },
  { value: "30d", label: "dashboard.period.month" },
  { value: "90d", label: "dashboard.period.quarter" },
];

type Granularity = "hourly" | "daily" | "weekly";
const GRANULARITIES: { value: Granularity; label: string }[] = [
  { value: "hourly", label: "시간별" },
  { value: "daily", label: "일자별" },
  { value: "weekly", label: "주별" },
];

// 모델별 토큰 카드 캐러셀 면 — 로컬 get_summary 의 range 의미 그대로 (1d=오늘 자정부터).
const MODEL_RANGES: { value: Range; label: string }[] = [
  { value: "1d", label: "오늘" },
  { value: "7d", label: "7일" },
  { value: "30d", label: "30일" },
];

function summaryTokenTotal(summary: Summary): number {
  return (
    summary.total_input_tokens +
    summary.total_output_tokens +
    summary.total_cache_read +
    summary.total_cache_write
  );
}

function pointTotals(points: readonly Point[]): { tokens: number; cost: number } {
  return points.reduce(
    (totals, point) => ({
      tokens:
        totals.tokens +
        point.input_tokens +
        point.output_tokens +
        (point.cache_read ?? 0) +
        (point.cache_write ?? 0),
      cost: totals.cost + point.cost_usd,
    }),
    { tokens: 0, cost: 0 }
  );
}

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

function todayLabel(nowMs: number): string {
  const d = new Date(nowMs);
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

export function Dashboard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  // 뷰 토글 — 메뉴 이동/재시작 후에도 마지막 선택값 유지 (usePersistentState).
  const [dailyRange, setDailyRange] = usePersistentState<Range>(
    "madup-token-monitor:dash:dailyRange",
    "7d"
  );
  const [dailyGranularity, setDailyGranularity] = usePersistentState<Granularity>(
    "madup-token-monitor:dash:dailyGranularity",
    "daily",
    // 월별 옵션 제거 전 저장된 값("monthly")이 남아있으면 기본값으로 되돌린다.
    (v): v is Granularity => v === "hourly" || v === "daily" || v === "weekly"
  );
  const [granularityAuto, setGranularityAuto] = usePersistentState(
    "madup-token-monitor:view:dash:granularityAuto",
    true
  );
  // 모델별 토큰 카드 자체 캐러셀 (오늘/7일/30일) — 수동 전환 전용 (자동 회전 없음).
  const [modelRange, setModelRange] = usePersistentState<Range>(
    "madup-token-monitor:dash:modelRange",
    "7d"
  );
  const [selectedMonth, setSelectedMonth] = useState<string>("");
  const [dailyMetric, setDailyMetric] = usePersistentState<"tokens" | "cost">(
    "madup-token-monitor:dash:dailyMetric",
    "tokens"
  );
  const [dailyView, setDailyView] = usePersistentState<"chart" | "list">(
    "madup-token-monitor:dash:dailyView",
    "chart"
  );
  const [usageScope, setUsageScope] = usePersistentState<UsageScope>(
    "madup-token-monitor:view:dash:usageSource",
    "combined",
    isUsageScope
  );
  const [refreshing, setRefreshing] = useState(false);
  const [lastSync, setLastSync] = useState<Date>(() => new Date());
  const [nowMs, setNowMs] = useState(() => Date.now());

  // 1초마다 lastSync 상대시간 갱신.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // granularity 자동 회전 — 7초 주기로 순환 (CompanyDashboard 의 intervalMs=7000 과 동일).
  // deps 에 dailyGranularity 포함: 수동 선택(점/화살표/회전) 직후 타이머가 리셋돼
  // 선택하자마자 면이 강제 전환되는 일이 없다. hover 중에는 일시정지 (PrismCarousel 규약).
  const [carouselHovered, setCarouselHovered] = useState(false);
  useEffect(() => {
    if (!granularityAuto || carouselHovered) return;
    const id = setInterval(() => {
      setDailyGranularity((prev) => {
        const i = GRANULARITIES.findIndex((g) => g.value === prev);
        return GRANULARITIES[(i + 1) % GRANULARITIES.length]!.value;
      });
    }, 7000);
    return () => clearInterval(id);
  }, [granularityAuto, carouselHovered, dailyGranularity, setDailyGranularity]);

  const { user } = useAuthUser();
  const {
    summary30,
    summary7,
    summary1,
    tsDaily,
    tsTodayDb,
    tsToday,
    tsMonth,
    tsAll,
    combinedTsTodayDb,
    combinedTs7,
    combinedTsMonth,
  } = useDashboardUsage(usageScope, dailyRange, dailyGranularity === "hourly" || granularityAuto);
  // DB 미보유 차원 — 로컬 유지(세션수/모델/소스비용/히트맵).
  const { data: heatmap } = useHeatmap(56, sourcesForScope(usageScope));
  // MCP / 플러그인 / 도구 — DB(security definer RPC, 본인 uid). 최근 7일.
  const { data: topMcp } = useUserMcp(user?.id ?? null, 7);
  const { data: topPlugins } = useUserPlugins(user?.id ?? null, 7);
  const { data: topTools } = useUserTools(user?.id ?? null, 7);
  const { data: deviceCount } = useMyDeviceCount(30);
  const { data: oauthResp } = useOAuthUsage();
  const { data: codexLimits } = useCodexRateLimits();
  const oauthUsage = oauthResp?.data ?? null;
  const oauthError = oauthResp?.error ?? null;

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["summary"] }),
        qc.invalidateQueries({ queryKey: ["timeseries"] }),
        qc.invalidateQueries({ queryKey: ["my_hourly"] }),
        qc.invalidateQueries({ queryKey: ["codexRateLimits"] }),
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
  const effectiveMonth = availableMonths.includes(selectedMonth)
    ? selectedMonth
    : (availableMonths[0] ?? "");

  const dailyAggregated = useMemo<AggRow[]>(() => {
    if (dailyGranularity === "hourly") {
      return aggregateByPeriod(tsToday ?? [], "hourly");
    }
    if (dailyGranularity === "daily") {
      return aggregateByPeriod(tsDaily ?? [], "daily");
    }
    const all = aggregateByPeriod(tsAll ?? [], "weekly");
    return all.filter(
      (w) => monthKey(new Date(w.date + "T00:00:00").getTime()) === effectiveMonth
    );
  }, [dailyGranularity, tsDaily, tsToday, tsAll, effectiveMonth]);

  const dailyLimit = DAILY_CARD_LIMIT[dailyRange] ?? 30;
  // 빈 시간/날짜/주/월을 0 으로 채워 차트·리스트에서 누락 없이 연속 표시.
  const dailyRows = useMemo<AggRow[]>(() => {
    if (dailyGranularity === "hourly") {
      return fillHourlyGaps(dailyAggregated);
    }
    if (dailyGranularity === "daily") {
      return fillDailyGaps(dailyAggregated, dailyLimit);
    }
    return fillWeeklyGaps(dailyAggregated, effectiveMonth);
  }, [dailyGranularity, dailyAggregated, dailyLimit, effectiveMonth]);

  // 7d 합산 / 월간 합산.
  const thisWeek = useMemo(() => calcRange(tsMonth ?? [], "this-week", nowMs), [tsMonth, nowMs]);
  const monthToDate = useMemo(
    () => calcRange(tsMonth ?? [], "this-month", nowMs),
    [tsMonth, nowMs]
  );
  const combinedMonthToDate = useMemo(
    () => calcRange(combinedTsMonth ?? [], "this-month", nowMs),
    [combinedTsMonth, nowMs]
  );
  const combinedSevenDay = useMemo(() => pointTotals(combinedTs7 ?? []), [combinedTs7]);

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

  // 오늘 토큰/비용/캐시 — DB(usage_aggregates 본인 전 기기) 기준. 다기기 합산.
  const todayKey = localDateKey(nowMs);
  const todayDb = (tsTodayDb ?? []).filter((p) => localDateKey(p.ts) === todayKey);
  const todayTokens = todayDb.reduce(
    (acc, p) => acc + p.input_tokens + p.output_tokens + (p.cache_read ?? 0) + (p.cache_write ?? 0),
    0
  );
  const todayCache = todayDb.reduce(
    (acc, p) => acc + (p.cache_read ?? 0) + (p.cache_write ?? 0),
    0
  );
  const todayCost = todayDb.reduce((acc, p) => acc + p.cost_usd, 0);
  const combinedTodayDb = (combinedTsTodayDb ?? []).filter(
    (point) => localDateKey(point.ts) === todayKey
  );
  const combinedTodayTokens = combinedTodayDb.reduce(
    (accumulator, point) =>
      accumulator +
      point.input_tokens +
      point.output_tokens +
      (point.cache_read ?? 0) +
      (point.cache_write ?? 0),
    0
  );
  const combinedTodayCost = combinedTodayDb.reduce(
    (accumulator, point) => accumulator + point.cost_usd,
    0
  );
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

  // 활동일 (히트맵 56일 기준) — 히트맵 하단 stat 표시용
  const activeDays = (heatmap ?? []).filter((d) => d.count > 0).length;
  // 평균 일일 토큰 — 분자(30일 토큰)와 분모(최근 30일 활동일)를 같은 창으로 맞춤.
  // 기존 버그: 30일 토큰을 56일 활동일로 나눠 과소 계산됨.
  const activeDays30 = new Set((tsMonth ?? []).map((point) => localDateKey(point.ts))).size;
  const avgDailyTokens = avgTokensPerActiveDay(summaryTokenTotal(summary30), activeDays30);
  const usageScopeLabel =
    USAGE_SCOPE_OPTIONS.find((option) => option.value === usageScope)?.label ?? "통합";

  // DB 미보유 차원 — 로컬 유지(소스비용 미니바). usage_aggregates 에 source 비용 분해 없음.
  const toolItems = summary7.by_source
    .map((s) => ({ label: s.source, value: s.cost_usd }))
    .sort((a, b) => b.value - a.value);
  // DB 미보유 차원 — 로컬 유지(모델별 토큰 미니바). usage_aggregates 에 model 차원 없음.
  // 다른 카드와 동일하게 캐시 포함 — 입력+출력만 합산하면 캐시 비중이 99%라
  // 값이 며칠씩 안 변하는 것처럼 보인다 (예: opus 5M 고정 이슈).
  // <synthetic>(모델 없음, 토큰 0)·0값 모델은 자리만 차지 — 제외.
  const modelSummary = modelRange === "1d" ? summary1 : modelRange === "30d" ? summary30 : summary7;
  const modelItems = (modelSummary?.by_model ?? [])
    .flatMap((model) => {
      const value = model.input_tokens + model.output_tokens + model.cache_read + model.cache_write;
      return model.model === "<synthetic>" || value <= 0
        ? []
        : [{ label: model.model.replace("claude-", ""), value }];
    })
    .sort((a, b) => b.value - a.value);

  function copyDailyToClipboard() {
    const lines = [
      ["Source", "Date", dailyMetric === "tokens" ? "Tokens" : "Cost (USD)"].join("\t"),
      ...dailyRows.map((d) =>
        [usageScopeLabel, d.date, dailyMetric === "tokens" ? d.tokens : d.cost.toFixed(4)].join(
          "\t"
        )
      ),
    ];
    navigator.clipboard.writeText(lines.join("\n")).catch(() => {});
  }

  function exportCsv() {
    const lines = [
      ["Source", "Date", "Tokens", "Cost USD"].join(","),
      ...dailyRows.map((d) =>
        [usageScopeLabel, d.date, String(d.tokens), d.cost.toFixed(4)].join(",")
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `madup-token-monitor-${usageScope}-${new Date().toISOString().slice(0, 10)}.csv`;
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
            {todayLabel(nowMs)} · 마지막 동기화 {formatRelativeShort(nowMs - lastSync.getTime())} 전
          </p>
        </div>
        <div className="flex gap-2 items-center shrink-0">
          <button type="button" onClick={exportCsv} className="mc-btn-outline">
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
            type="button"
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
            <span className="mc-eyebrow">오늘 · {usageScopeLabel}</span>
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
                입력 + 출력 + 캐시 read/write 합산 · {usageScopeLabel} 기준
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
                <TodayStat label="세션" value={String(todaySessions)} sub="개" color="violet" />
                <TodayStat
                  label="활성 기기"
                  value={String(deviceCount ?? 1)}
                  sub="대"
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

        <UsageSourceCarousel
          scope={usageScope}
          onScopeChange={setUsageScope}
          combinedTotals={[
            { label: "오늘", tokens: combinedTodayTokens, cost: combinedTodayCost },
            {
              label: "최근 7일",
              tokens: combinedSevenDay.tokens,
              cost: combinedSevenDay.cost,
            },
            {
              label: "이번 달",
              tokens: combinedMonthToDate.tokens,
              cost: combinedMonthToDate.cost,
            },
          ]}
          claudeUsage={oauthUsage}
          claudeError={oauthError}
          codexLimits={codexLimits ?? []}
          refreshing={refreshing}
          lastSyncLabel={formatRelativeShort(nowMs - lastSync.getTime())}
          nowMs={nowMs}
          onRefresh={handleRefresh}
        />

        {/* ============ ROW 2: Daily breakdown (col-8) ============ */}
        {/* display:contents — 그리드 배치는 PeriodChartCard 의 col-span 이 그대로 적용되고,
            hover 이벤트만 버블링으로 받아 자동 회전을 일시정지한다. */}
        <div
          className="contents"
          onMouseEnter={() => setCarouselHovered(true)}
          onMouseLeave={() => setCarouselHovered(false)}
        >
          <PeriodChartCard
            leftHeader={
              <>
                <span className="text-[15px] font-semibold text-text-primary tracking-[-0.005em]">
                  기간별 사용량
                  {/* CarouselCard 헤더의 활성 면 제목 패턴 — 현재 granularity 라벨을 작게 표시 */}
                  <span className="text-text-tertiary font-normal text-[12px] ml-1">
                    {usageScopeLabel} ·{" "}
                    {GRANULARITIES.find((g) => g.value === dailyGranularity)?.label}
                  </span>
                </span>
                <CarouselControls
                  count={GRANULARITIES.length}
                  activeIndex={Math.max(
                    0,
                    GRANULARITIES.findIndex((g) => g.value === dailyGranularity)
                  )}
                  onIndexChange={(i) => setDailyGranularity(GRANULARITIES[i]!.value)}
                  labels={GRANULARITIES.map((g) => g.label)}
                  auto={granularityAuto}
                  onAutoChange={setGranularityAuto}
                />
                {dailyGranularity === "hourly" ? null : dailyGranularity === "daily" ? (
                  <Select
                    value={dailyRange}
                    onChange={(v) => setDailyRange(v as Range)}
                    options={RANGES.map((r) => ({ value: r.value, label: t(r.label) }))}
                    ariaLabel="기간 선택"
                  />
                ) : (
                  <Select
                    value={effectiveMonth}
                    onChange={setSelectedMonth}
                    options={availableMonths.map((m) => ({ value: m, label: monthLabel(m) }))}
                    ariaLabel="월 선택"
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
                  : r.date.slice(5)
            }
            onCopy={copyDailyToClipboard}
            emptyText={t("dashboard.empty")}
          />
        </div>

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
                      <div className="num text-[20px] font-medium text-lime">{activeDays}/56</div>
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
                      label: prettyPluginId(p.plugin_id),
                      title: p.plugin_id,
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
          eyebrow={`이번 주 · ${usageScopeLabel}`}
          value={formatTokensCompact(thisWeek.tokens)}
          suffix="tokens"
          subline={
            <>
              <span className="num text-text-secondary">{formatTokensCompact(thisWeek.cache)}</span>{" "}
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
          eyebrow={`이번 달 · ${usageScopeLabel}`}
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
            <span className="mc-eyebrow">소스별 비용 · {usageScopeLabel}</span>
          </header>
          <MiniBarList items={toolItems} formatValue={(v) => formatUSD(v)} emphasizeMax="amber" />
        </section>

        <section className="mc-card col-span-3">
          <header className="mb-3.5 flex items-center justify-between gap-2 flex-wrap">
            <span className="mc-eyebrow">
              모델별 토큰 · {usageScopeLabel} ·{" "}
              {MODEL_RANGES.find((r) => r.value === modelRange)?.label}
            </span>
            <CarouselControls
              count={MODEL_RANGES.length}
              activeIndex={Math.max(
                0,
                MODEL_RANGES.findIndex((r) => r.value === modelRange)
              )}
              onIndexChange={(i) => setModelRange(MODEL_RANGES[i]!.value)}
              labels={MODEL_RANGES.map((r) => r.label)}
            />
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
  nowMs: number
): { tokens: number; cost: number; cache: number; days: number; totalInput: number } {
  if (ts.length === 0) return { tokens: 0, cost: 0, cache: 0, days: 0, totalInput: 0 };
  const now = new Date(nowMs);
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
    end = nowMs;
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
