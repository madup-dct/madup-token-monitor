import { useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  useUserMcp,
  useUserPlugins,
  useUserTools,
  type CompanyLeaderboardEntry,
} from "@/hooks/useUsage";
import {
  fetchUserDailyAggregates,
  fetchUserHourly,
  fetchUserProfile,
  assignAppRole,
  type UserDailyAggregate,
  type UserHourlyAggregate,
} from "@/lib/teams";
import { usePersistentState } from "@/lib/usePersistentState";
import { KpiHero } from "@/components/dashboard/KpiHero";
import { PeriodChartCard, type PeriodRow } from "@/components/dashboard/PeriodChartCard";
import { CarouselCard } from "@/components/dashboard/CarouselCard";
import { RankBarList } from "@/components/ui/RankBarList";
import { HeatMap } from "@/components/HeatMap";
import { Select } from "@/components/ui/Select";
import { useRole } from "@/hooks/useRole";
import type { AppRole } from "@/types/models";
import { formatTokensCompact, formatUSD, formatKRW } from "@/lib/format";
import { prettyToolName } from "@/lib/labels";

const ROLE_OPTIONS: { value: AppRole; label: string }[] = [
  { value: "user", label: "user" },
  { value: "team_leader", label: "team_leader" },
  { value: "manager", label: "manager" },
  { value: "admin", label: "admin" },
];

interface NavState {
  entry?: CompanyLeaderboardEntry;
  rangeDays?: number;
  periodLabel?: string;
}

type Granularity = "hourly" | "daily" | "weekly" | "monthly";
type DailyRange = 7 | 30 | 90;
const KRW_RATE = 1370; // 대략 환율 — 추후 실시간 RPC

const HISTORY_DAYS = 365; // 1년치 fetch 한 번 + 클라이언트 집계

function localDateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function weekStartKey(ts: number): string {
  const d = new Date(ts);
  const dow = (d.getDay() + 6) % 7; // 월=0..일=6
  d.setDate(d.getDate() - dow);
  d.setHours(0, 0, 0, 0);
  return localDateKey(d.getTime());
}
function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function weekLabel(weekStart: string): string {
  const d = new Date(weekStart + "T00:00:00");
  return `${d.getMonth() + 1}/${d.getDate()}~`;
}
function monthLabel(mk: string): string {
  const [y, m] = mk.split("-");
  return `${y!.slice(2)}년 ${parseInt(m!, 10)}월`;
}
function localHourKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:00`;
}

/// usage_hourly (UTC 버킷) 를 로컬 정시 버킷으로 합산.
function aggregateHourly(rows: UserHourlyAggregate[]): PeriodRow[] {
  const map = new Map<string, { tokens: number; cost: number }>();
  for (const r of rows) {
    const ts = new Date(r.hour_utc).getTime();
    const key = localHourKey(ts);
    const cur = map.get(key) ?? { tokens: 0, cost: 0 };
    cur.tokens +=
      Number(r.input_tokens) +
      Number(r.output_tokens) +
      Number(r.cache_read) +
      Number(r.cache_write);
    cur.cost += Number(r.cost_usd);
    map.set(key, cur);
  }
  return Array.from(map.entries())
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/// 현재 시각 기준 직전 `hours` 개 로컬 정시 버킷을 0 으로 채워 연속 표시.
function fillHourlyGaps(rows: PeriodRow[], hours: number): PeriodRow[] {
  const map = new Map(rows.map((r) => [r.date, r]));
  const now = new Date();
  now.setMinutes(0, 0, 0);
  const out: PeriodRow[] = [];
  for (let i = hours - 1; i >= 0; i--) {
    const key = localHourKey(now.getTime() - i * 3600_000);
    out.push(map.get(key) ?? { date: key, tokens: 0, cost: 0 });
  }
  return out;
}

function fillDailyGaps(rows: PeriodRow[], days: number): PeriodRow[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const map = new Map(rows.map((r) => [r.date, r]));
  const out: PeriodRow[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = localDateKey(d.getTime());
    out.push(map.get(key) ?? { date: key, tokens: 0, cost: 0 });
  }
  return out;
}
function fillWeeklyGaps(rows: PeriodRow[], weeks: number): PeriodRow[] {
  const today = new Date();
  const thisWeek = weekStartKey(today.getTime());
  const map = new Map(rows.map((r) => [r.date, r]));
  const out: PeriodRow[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(thisWeek + "T00:00:00");
    d.setDate(d.getDate() - i * 7);
    const key = localDateKey(d.getTime());
    out.push(map.get(key) ?? { date: key, tokens: 0, cost: 0 });
  }
  return out;
}
function fillMonthlyGaps(rows: PeriodRow[], months: number): PeriodRow[] {
  const today = new Date();
  const map = new Map(rows.map((r) => [r.date, r]));
  const out: PeriodRow[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const key = monthKey(d.getTime());
    out.push(map.get(key) ?? { date: key, tokens: 0, cost: 0 });
  }
  return out;
}

function aggregate(daily: UserDailyAggregate[], keyFn: (ts: number) => string): PeriodRow[] {
  const map = new Map<string, { tokens: number; cost: number }>();
  for (const r of daily) {
    const ts = new Date(r.date + "T00:00:00").getTime();
    const key = keyFn(ts);
    const cur = map.get(key) ?? { tokens: 0, cost: 0 };
    cur.tokens += Number(r.total_tokens);
    cur.cost += Number(r.total_cost_usd);
    map.set(key, cur);
  }
  return Array.from(map.entries())
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export default function UserDashboard() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const state = (location.state ?? {}) as NavState;
  const passedEntry = state.entry ?? null;

  const [granularity, setGranularity] = usePersistentState<Granularity>(
    "madup-token-monitor:view:user:granularity",
    "daily",
  );
  const [dailyRange, setDailyRange] = usePersistentState<DailyRange>(
    "madup-token-monitor:view:user:dailyRange",
    30,
  );
  const [metric, setMetric] = usePersistentState<"tokens" | "cost">(
    "madup-token-monitor:view:user:metric",
    "tokens",
  );
  const [view, setView] = usePersistentState<"chart" | "list">(
    "madup-token-monitor:view:user:view",
    "chart",
  );

  // entry 가 없으면 (직접 URL 진입) profile 조회.
  const profileQ = useQuery({
    queryKey: ["profile_lookup", id],
    queryFn: () => fetchUserProfile(id!),
    enabled: !!id && !passedEntry,
  });

  const displayName =
    passedEntry?.display_name ??
    profileQ.data?.slack_handle ??
    profileQ.data?.name ??
    profileQ.data?.email ??
    id ??
    "—";
  const avatarUrl = passedEntry?.avatar_url ?? profileQ.data?.avatar_url ?? null;
  const subEmail = profileQ.data?.email ?? null;

  // 365 일치 fetch 한 번 + 클라이언트 집계.
  const dailyQ = useQuery({
    queryKey: ["user_daily_aggregates", id, HISTORY_DAYS],
    queryFn: () => fetchUserDailyAggregates(id!, HISTORY_DAYS),
    enabled: !!id,
    staleTime: 60_000,
  });
  const daily = (dailyQ.data ?? []) as UserDailyAggregate[];

  // 시간별은 usage_hourly 직접 조회 (최근 48h fetch, 24h 표시). granularity=hourly 일 때만.
  const hourlyQ = useQuery({
    queryKey: ["user_hourly", id, 48],
    queryFn: () => fetchUserHourly(id!, 48),
    enabled: !!id && granularity === "hourly",
    staleTime: 60_000,
  });
  const hourly = (hourlyQ.data ?? []) as UserHourlyAggregate[];

  // granularity 별 row 와 라벨 포맷.
  const { rows, labelFormat, periodLabel } = useMemo(() => {
    if (granularity === "hourly") {
      const filled = fillHourlyGaps(aggregateHourly(hourly), 24);
      return {
        rows: filled,
        labelFormat: (r: PeriodRow) => `${r.date.slice(11, 13)}시`,
        periodLabel: "최근 24시간 · 시간별",
      };
    }
    if (granularity === "weekly") {
      const weekly = aggregate(daily, weekStartKey);
      const filled = fillWeeklyGaps(weekly, 12);
      return {
        rows: filled,
        labelFormat: (r: PeriodRow) => weekLabel(r.date),
        periodLabel: "최근 12주 · 주별",
      };
    }
    if (granularity === "monthly") {
      const monthly = aggregate(daily, monthKey);
      const filled = fillMonthlyGaps(monthly, 12);
      return {
        rows: filled,
        labelFormat: (r: PeriodRow) => monthLabel(r.date),
        periodLabel: "최근 12개월 · 월별",
      };
    }
    // daily
    const dailyAgg = aggregate(daily, localDateKey);
    const filled = fillDailyGaps(dailyAgg, dailyRange);
    return {
      rows: filled,
      labelFormat: (r: PeriodRow) => r.date.slice(5),
      periodLabel: `최근 ${dailyRange}일 · 일자별`,
    };
  }, [daily, hourly, granularity, dailyRange]);

  // KPI: 최근 30일 합계 (변경되지 않게 일관).
  const kpi = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const cutoff = new Date(today);
    cutoff.setDate(today.getDate() - 29);
    let tokens = 0;
    let cost = 0;
    let activeDays = 0;
    const seenDates = new Set<string>();
    for (const r of daily) {
      const ts = new Date(r.date + "T00:00:00").getTime();
      if (ts < cutoff.getTime() || ts > today.getTime()) continue;
      tokens += Number(r.total_tokens);
      cost += Number(r.total_cost_usd);
      if (!seenDates.has(r.date) && (Number(r.total_tokens) > 0 || Number(r.total_cost_usd) > 0)) {
        seenDates.add(r.date);
        activeDays += 1;
      }
    }
    return { tokens, cost, activeDays };
  }, [daily]);

  const avgDaily = kpi.activeDays > 0 ? kpi.tokens / kpi.activeDays : 0;

  // RPC mcp/plugins — 일관성을 위해 30일 기준 고정.
  const mcp = useUserMcp(id ?? null, 30);
  const plugins = useUserPlugins(id ?? null, 30);
  const tools = useUserTools(id ?? null, 30);

  const isAdmin = useRole("admin");
  const [roleMsg, setRoleMsg] = useState<string | null>(null);

  // 활동량 히트맵 — usage_aggregates 일별을 날짜별 합산해 DayCount 로 (count=토큰 강도).
  const heatmapData = useMemo(
    () =>
      aggregate(daily, localDateKey).map((r) => ({
        date: r.date,
        count: Math.round(r.tokens),
        cost_usd: r.cost,
      })),
    [daily],
  );

  async function handleAssignRole(role: AppRole) {
    if (!id) return;
    setRoleMsg(null);
    try {
      await assignAppRole(id, role);
      setRoleMsg(`권한을 ${role} 로 설정했습니다.`);
    } catch (e) {
      setRoleMsg("권한 부여 실패: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  function copyToClipboard() {
    const lines = [
      ["Period", metric === "tokens" ? "Tokens" : "Cost (USD)"].join("\t"),
      ...rows.map((r) => [labelFormat(r), metric === "tokens" ? r.tokens : r.cost.toFixed(4)].join("\t")),
    ];
    navigator.clipboard.writeText(lines.join("\n")).catch(() => {});
  }

  return (
    <div className="px-7 pt-5 pb-8">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 mb-5 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={() => navigate(-1)}
            aria-label="뒤로"
            title="뒤로"
            className="mc-icon-btn"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 12L6 8l4-4" />
            </svg>
          </button>
          {avatarUrl ? (
            <img src={avatarUrl} alt={displayName} className="w-10 h-10 rounded-full object-cover" />
          ) : (
            <div className="w-10 h-10 rounded-full bg-surface-2" />
          )}
          <div className="min-w-0">
            <h1 className="text-[22px] font-bold tracking-[-0.01em] text-text-primary leading-tight truncate">
              {displayName} 의 대시보드
            </h1>
            <p className="text-[12px] text-text-tertiary mt-0.5">
              {subEmail ? `${subEmail} · ` : ""}최근 30일 기준 KPI
            </p>
          </div>
        </div>
        {isAdmin && id ? (
          <div className="flex flex-col items-end gap-1 shrink-0">
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-text-tertiary">권한 부여</span>
              <Select
                value=""
                onChange={(v) => {
                  if (v) handleAssignRole(v as AppRole);
                }}
                options={[{ value: "", label: "역할 선택…" }, ...ROLE_OPTIONS]}
                ariaLabel="권한 부여"
              />
            </div>
            {roleMsg ? (
              <span className="text-[10.5px] text-text-tertiary max-w-[220px] text-right">
                {roleMsg}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* KPI Hero — 30일 합계 */}
      <div className="grid grid-cols-12 gap-4 mb-4">
        <KpiHero
          eyebrow="30일 · TOKENS"
          value={formatTokensCompact(kpi.tokens)}
          color="azure"
          context={`평균 일별 ${formatTokensCompact(avgDaily)}`}
        />
        <KpiHero
          eyebrow="30일 · COST"
          value={formatUSD(kpi.cost)}
          color="amber"
          context={formatKRW(kpi.cost * KRW_RATE)}
        />
        <KpiHero
          eyebrow="활동일"
          value={`${kpi.activeDays}`}
          suffix="/ 30"
          color="lime"
        />
        {passedEntry ? (
          <KpiHero
            eyebrow="순위 (리더보드)"
            value={`#${passedEntry.rank}`}
            color="violet"
            context={state.periodLabel ?? "선택 기간"}
          />
        ) : (
          <KpiHero eyebrow="순위" value="—" color="violet" context="리더보드 진입 시 표시" />
        )}
      </div>

      {/* 기간별 사용량 + side rails */}
      <div className="grid grid-cols-12 gap-4">
        <PeriodChartCard
          leftHeader={
            <>
              <span className="text-[15px] font-semibold text-text-primary tracking-[-0.005em]">
                기간별 사용량
              </span>
              <Select
                value={granularity}
                onChange={(v) => setGranularity(v as Granularity)}
                options={[
                  { value: "hourly", label: "시간별" },
                  { value: "daily", label: "일자별" },
                  { value: "weekly", label: "주별" },
                  { value: "monthly", label: "월별" },
                ]}
                ariaLabel="단위 선택"
              />
              {granularity === "daily" ? (
                <Select
                  value={String(dailyRange)}
                  onChange={(v) => setDailyRange(Number(v) as DailyRange)}
                  options={[
                    { value: "7", label: "7일" },
                    { value: "30", label: "30일" },
                    { value: "90", label: "90일" },
                  ]}
                  ariaLabel="기간 선택"
                />
              ) : (
                <span className="text-[11px] text-text-tertiary">{periodLabel}</span>
              )}
            </>
          }
          rows={rows}
          metric={metric}
          onMetricChange={setMetric}
          view={view}
          onViewChange={setView}
          highlightLast
          chartType={granularity === "hourly" ? "line" : "auto"}
          labelFormat={labelFormat}
          onCopy={copyToClipboard}
        />

        <CarouselCard
          persistKey="madup-token-monitor:view:user:carousel"
          className="col-span-4"
          height={320}
          faces={[
            {
              key: "heatmap",
              title: "활동",
              subtitle: "최근 8주 · 토큰 강도",
              node: (
                <div className="h-full">
                  <HeatMap data={heatmapData} weeks={8} />
                </div>
              ),
            },
            {
              key: "mcp",
              title: "MCP 사용량",
              subtitle: "최근 30일",
              node: (
                <div className="h-full pr-1">
                  {mcp.error ? (
                    <div className="text-[12px] text-coral mb-2 px-1">
                      RPC 실패: {String(mcp.error.message)}
                    </div>
                  ) : null}
                  <RankBarList
                    items={(mcp.data ?? []).map((m) => ({
                      label: m.mcp_server,
                      value: Number(m.count),
                    }))}
                    formatValue={(v) => v.toLocaleString("ko-KR")}
                    emptyMessage={mcp.isLoading ? "로딩 중…" : "MCP 사용 기록 없음 (최근 30일)"}
                  />
                </div>
              ),
            },
            {
              key: "plugins",
              title: "플러그인 사용량",
              subtitle: "최근 30일",
              node: (
                <div className="h-full pr-1">
                  {plugins.error ? (
                    <div className="text-[12px] text-coral mb-2 px-1">
                      RPC 실패: {String(plugins.error.message)}
                    </div>
                  ) : null}
                  <RankBarList
                    items={(plugins.data ?? []).map((p) => ({
                      label: p.plugin_id,
                      value: Number(p.count),
                    }))}
                    formatValue={(v) => v.toLocaleString("ko-KR")}
                    emptyMessage={plugins.isLoading ? "로딩 중…" : "플러그인 사용 기록 없음 (최근 30일)"}
                  />
                </div>
              ),
            },
            {
              key: "tools",
              title: "도구 사용량",
              subtitle: "최근 30일",
              node: (
                <div className="h-full pr-1">
                  {tools.error ? (
                    <div className="text-[12px] text-coral mb-2 px-1">
                      RPC 실패: {String(tools.error.message)}
                    </div>
                  ) : null}
                  <RankBarList
                    items={(tools.data ?? []).map((t) => ({
                      label: prettyToolName(t.tool_name),
                      value: t.count,
                    }))}
                    formatValue={(v) => v.toLocaleString("ko-KR")}
                    emptyMessage={tools.isLoading ? "로딩 중…" : "도구 사용 기록 없음 (최근 30일)"}
                  />
                </div>
              ),
            },
          ]}
        />
      </div>

      <p className="text-[11px] text-text-faint mt-5 pt-3 border-t border-hairline">
        본인 전용 데이터(OAuth 한도, 세션 수, 시간별)는 표시되지 않습니다.
      </p>
    </div>
  );
}
