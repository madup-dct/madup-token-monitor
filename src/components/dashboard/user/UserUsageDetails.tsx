import { MiniStatCard } from "@/components/dashboard/MiniStatCard";
import { PeriodChartCard } from "@/components/dashboard/PeriodChartCard";
import { Select } from "@/components/ui/Select";
import { UserActivityCarousel } from "@/components/dashboard/user/UserActivityCarousel";
import type { UserToolRow } from "@/hooks/useUsage";
import { formatTokensCompact, formatUSD } from "@/lib/format";
import type {
  UserDashboardUsage,
  UserUsageDailyRange,
  UserUsageGranularity,
} from "@/lib/user-dashboard-usage";
import type { McpUsage, PluginUsage } from "@/types/models";

interface UsageList<T> {
  data: readonly T[];
  error: Error | null;
  isLoading: boolean;
}

interface UserUsageDetailsProps {
  usage: UserDashboardUsage;
  scopeLabel: string;
  granularity: UserUsageGranularity;
  dailyRange: UserUsageDailyRange;
  metric: "tokens" | "cost";
  view: "chart" | "list";
  onGranularityChange: (value: UserUsageGranularity) => void;
  onDailyRangeChange: (value: UserUsageDailyRange) => void;
  onMetricChange: (value: "tokens" | "cost") => void;
  onViewChange: (value: "chart" | "list") => void;
  onCopy: () => void;
  mcp: UsageList<McpUsage>;
  plugins: UsageList<PluginUsage>;
  tools: UsageList<UserToolRow>;
}

export function UserUsageDetails({
  usage,
  scopeLabel,
  granularity,
  dailyRange,
  metric,
  view,
  onGranularityChange,
  onDailyRangeChange,
  onMetricChange,
  onViewChange,
  onCopy,
  mcp,
  plugins,
  tools,
}: UserUsageDetailsProps) {
  return (
    <>
      <PeriodChartCard
        className="max-[1339px]:col-span-12"
        leftHeader={
          <>
            <span className="text-[15px] font-semibold text-text-primary tracking-[-0.005em]">
              기간별 사용량
            </span>
            <span className="mc-eyebrow">{scopeLabel} · 캐시 포함</span>
            <Select
              value={granularity}
              onChange={(value) => onGranularityChange(value as UserUsageGranularity)}
              options={[
                { value: "hourly", label: "시간별" },
                { value: "daily", label: "일자별" },
                { value: "weekly", label: "주별" },
              ]}
              ariaLabel="단위 선택"
            />
            {granularity === "daily" ? (
              <Select
                value={String(dailyRange)}
                onChange={(value) => onDailyRangeChange(Number(value) as UserUsageDailyRange)}
                options={[
                  { value: "7", label: "7일" },
                  { value: "30", label: "30일" },
                  { value: "90", label: "90일" },
                ]}
                ariaLabel="기간 선택"
              />
            ) : (
              <span className="text-[11px] text-text-tertiary">{usage.periodLabel}</span>
            )}
          </>
        }
        rows={usage.rows}
        metric={metric}
        onMetricChange={onMetricChange}
        view={view}
        onViewChange={onViewChange}
        highlightLast
        chartType={granularity === "hourly" ? "line" : "auto"}
        labelFormat={usage.labelFormat}
        onCopy={onCopy}
      />

      <UserActivityCarousel
        scopeLabel={scopeLabel}
        heatmapData={usage.heatmapData}
        mcp={mcp}
        plugins={plugins}
        tools={tools}
      />

      <MiniStatCard
        colSpan={6}
        eyebrow={`${scopeLabel} · 이번 주 · 월~일`}
        value={formatTokensCompact(usage.thisWeek.tokens)}
        suffix="tokens"
        subline={<>{usage.thisWeek.days}일 활동</>}
        foot={[{ label: "비용", value: formatUSD(usage.thisWeek.cost) }]}
      />
      <MiniStatCard
        colSpan={6}
        eyebrow={`${scopeLabel} · 이번 달 · ${usage.thisMonthLabel}`}
        value={formatTokensCompact(usage.thisMonth.tokens)}
        suffix="tokens"
        subline={<>{usage.thisMonth.days}일 활동</>}
        foot={[{ label: "비용", value: formatUSD(usage.thisMonth.cost) }]}
      />
    </>
  );
}
