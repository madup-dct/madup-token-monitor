import { Sparkline } from "@/components/ui/Sparkline";
import { TodayStat } from "@/components/dashboard/TodayStat";
import type { UserDashboardUsage } from "@/lib/user-dashboard-usage";
import { formatKRW, formatTokensCompact, formatUSD } from "@/lib/format";

interface UserUsageOverviewProps {
  usage: UserDashboardUsage;
  scopeLabel: string;
}

export function UserUsageOverview({ usage, scopeLabel }: UserUsageOverviewProps) {
  const deltaUp = usage.todayVsWeek >= 0;

  return (
    <>
      <section className="mc-card-feature col-span-8 max-[1339px]:col-span-12">
        <header className="flex items-center justify-between mb-3.5 gap-3 relative">
          <span className="mc-eyebrow">오늘 · {scopeLabel}</span>
          {usage.weekAvgDailyTokens > 0 ? (
            <span className={deltaUp ? "mc-delta-up" : "mc-delta-down"}>
              {deltaUp ? "+" : "−"}
              {Math.abs(usage.todayVsWeek * 100).toFixed(0)}% vs 7d 평균
            </span>
          ) : null}
        </header>

        <div className="grid grid-cols-[1fr_220px] gap-6 items-start">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2.5">
              <span className="num text-[48px] font-medium leading-none tracking-[-0.02em] text-azure">
                {formatTokensCompact(usage.todayTokens)}
              </span>
              <span className="text-[13px] text-text-secondary">tokens</span>
            </div>
            <p className="text-[12px] text-text-tertiary mt-2.5 leading-snug">
              {scopeLabel} 입력·출력·캐시 토큰을 합산한 처리량입니다.
            </p>

            <div className="mt-6 grid grid-cols-3 gap-4 pt-5 border-t border-hairline">
              <TodayStat
                label="비용"
                value={formatUSD(usage.todayCost)}
                sub={<span className="num">{formatKRW(usage.todayCost)}</span>}
                color="amber"
              />
              <TodayStat label="활동일" value={`${usage.kpi.activeDays}`} sub="/ 30" color="lime" />
              <TodayStat label="순위" value="—" sub="소스별 순위 미지원" color="violet" />
            </div>
          </div>

          <div className="rounded-[10px] border border-hairline p-3.5 pb-2.5 bg-surface-2">
            <div className="text-[10px] font-bold tracking-[0.14em] uppercase text-text-tertiary mb-1.5">
              최근 7일 추이
            </div>
            <div className="text-[15px] font-medium text-text-primary mb-1">
              <span className="num">
                {formatTokensCompact(usage.sparkValues[usage.sparkValues.length - 1] ?? 0)}
              </span>{" "}
              <span className="text-text-tertiary text-[11px]">↘ 오늘</span>
            </div>
            <Sparkline values={usage.sparkValues} width={190} height={84} />
            <div className="flex justify-between num text-[9.5px] text-text-faint mt-1">
              <span>{usage.last7[0]?.date.slice(5) ?? ""}</span>
              <span>{usage.last7[Math.floor(usage.last7.length / 2)]?.date.slice(5) ?? ""}</span>
              <span>{usage.last7[usage.last7.length - 1]?.date.slice(5) ?? ""}</span>
            </div>
          </div>
        </div>
      </section>

      <section className="mc-card col-span-4 max-[1339px]:col-span-12">
        <header className="flex items-center justify-between mb-3.5 gap-3">
          <span className="text-[15px] font-semibold text-text-primary tracking-[-0.005em]">
            30일 요약
          </span>
          <span className="text-[11px] text-text-tertiary">{scopeLabel} · 캐시 포함</span>
        </header>
        <div className="grid grid-cols-2 gap-x-4 gap-y-5">
          <TodayStat
            label="총 처리 토큰"
            value={formatTokensCompact(usage.kpi.tokens)}
            sub={<span className="num">{formatUSD(usage.kpi.cost)}</span>}
            color="azure"
          />
          <TodayStat
            label="총 비용"
            value={formatUSD(usage.kpi.cost)}
            sub={<span className="num">{formatKRW(usage.kpi.cost)}</span>}
            color="amber"
          />
          <TodayStat
            label="평균 일별"
            value={formatTokensCompact(usage.avgDaily)}
            sub="활동일 기준"
            color="violet"
          />
          <TodayStat label="활동일" value={`${usage.kpi.activeDays}`} sub="/ 30" color="lime" />
        </div>
      </section>
    </>
  );
}
