import { CarouselControls } from "@/components/ui/CarouselControls";
import { PrismCarousel } from "@/components/ui/PrismCarousel";
import { ClaudeLimits, CodexLimits } from "@/components/dashboard/UsageLimitPanel";
import type { OAuthUsage } from "@/hooks/useRateLimits";
import { formatTokensCompact, formatUSD } from "@/lib/format";
import { USAGE_SCOPE_OPTIONS, type UsageScope } from "@/lib/usage-sources";
import type { CodexRateLimitSnapshot } from "@/types/models";

export interface PeriodUsageTotal {
  readonly label: string;
  readonly tokens: number;
  readonly cost: number;
}

interface UsageSourceCarouselProps {
  readonly scope: UsageScope;
  readonly onScopeChange: (scope: UsageScope) => void;
  readonly combinedTotals: readonly PeriodUsageTotal[];
  readonly claudeUsage: OAuthUsage | null;
  readonly claudeError: string | null;
  readonly codexLimits: readonly CodexRateLimitSnapshot[];
  readonly refreshing: boolean;
  readonly lastSyncLabel: string;
  readonly nowMs: number;
  readonly onRefresh: () => void;
}

export function UsageSourceCarousel({
  scope,
  onScopeChange,
  combinedTotals,
  claudeUsage,
  claudeError,
  codexLimits,
  refreshing,
  lastSyncLabel,
  nowMs,
  onRefresh,
}: UsageSourceCarouselProps) {
  const activeIndex = USAGE_SCOPE_OPTIONS.findIndex((option) => option.value === scope);
  const activeLabel = USAGE_SCOPE_OPTIONS[activeIndex]?.label ?? "통합";
  const title = scope === "combined" ? "통합 사용량" : `${activeLabel} 한도`;

  function changeIndex(index: number) {
    const option = USAGE_SCOPE_OPTIONS[index];
    if (option) onScopeChange(option.value);
  }

  return (
    <section className="mc-card col-span-4" aria-label="토큰 데이터 소스">
      <header className="flex items-center justify-between mb-3.5 gap-3 relative">
        <span className="min-w-0 whitespace-nowrap text-[15px] font-semibold text-text-primary tracking-[-0.005em]">
          {title}
        </span>
        <CarouselControls
          count={USAGE_SCOPE_OPTIONS.length}
          activeIndex={activeIndex}
          onIndexChange={changeIndex}
          labels={USAGE_SCOPE_OPTIONS.map((option) => `${option.label} 보기`)}
          className="mc-source-carousel-controls"
        />
      </header>

      <PrismCarousel
        activeIndex={activeIndex}
        onIndexChange={changeIndex}
        auto={false}
        height={scope === "combined" ? 180 : 248}
        motion="slide"
        faces={[
          {
            key: "combined",
            node: <CombinedUsage totals={combinedTotals} />,
          },
          {
            key: "claude",
            node: <ClaudeLimits usage={claudeUsage} error={claudeError} nowMs={nowMs} />,
          },
          {
            key: "codex",
            node: <CodexLimits snapshots={codexLimits} nowMs={nowMs} />,
          },
        ]}
      />

      <div className="mt-3.5 pt-3.5 border-t border-hairline flex justify-between items-center">
        <span className="text-[11px] text-text-tertiary">{lastSyncLabel} 전 동기화됨</span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-hairline bg-surface-2 text-text-secondary text-[11.5px] font-medium hover:text-text-primary hover:border-hairline-strong transition-colors disabled:opacity-60"
        >
          <RefreshIcon spinning={refreshing} />
          새로고침
        </button>
      </div>
    </section>
  );
}

function CombinedUsage({ totals }: { readonly totals: readonly PeriodUsageTotal[] }) {
  return (
    <div className="h-full rounded-[10px] border border-hairline px-3.5 bg-surface-2">
      {totals.map((total, index) => (
        <div
          key={total.label}
          className={`flex items-center justify-between py-2 gap-4 ${index > 0 ? "border-t border-hairline" : ""}`}
        >
          <span className="text-[12px] font-semibold text-text-secondary">{total.label}</span>
          <span className="text-right">
            <strong className="num block text-[16px] font-medium text-azure">
              {formatTokensCompact(total.tokens)}
            </strong>
            <span className="num text-[10.5px] text-text-tertiary">{formatUSD(total.cost)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function RefreshIcon({ spinning }: { readonly spinning: boolean }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      className={spinning ? "animate-spin" : undefined}
    >
      <path d="M2 8a6 6 0 0110.3-4.2L14 2v4h-4M14 8a6 6 0 01-10.3 4.2L2 14v-4h4" />
    </svg>
  );
}
