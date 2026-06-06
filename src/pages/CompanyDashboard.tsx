import { useMemo, useState } from "react";
import { usePersistentState } from "@/lib/usePersistentState";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCompanyLeaderboard,
  useCompanyTopMcp,
  useCompanyTopPlugins,
  useSummary,
  type LeaderboardRange,
} from "@/hooks/useUsage";
import { useAuthUser } from "@/hooks/useAuthUser";
import { roleAtLeast } from "@/hooks/useRole";
import { Sparkline } from "@/components/ui/Sparkline";
import { RingMeter } from "@/components/ui/RingMeter";
import { RankBarList } from "@/components/ui/RankBarList";
import { Leaderboard } from "@/components/charts/Leaderboard";
import { PrismCarousel } from "@/components/ui/PrismCarousel";
import { KpiHero } from "@/components/dashboard/KpiHero";
import {
  formatTokensCompact,
  formatUSD,
  formatKRW,
} from "@/lib/format";

const RANGES: LeaderboardRange[] = ["today", "week", "month"];

const PERIOD_SUFFIX: Record<LeaderboardRange, string> = {
  today: "오늘",
  week: "이번 주",
  month: "이번 달",
};

export default function CompanyDashboard() {
  const qc = useQueryClient();
  const { user, role } = useAuthUser();
  const navigate = useNavigate();
  const [carouselIdx, setCarouselIdx] = usePersistentState(
    "madup-token-monitor:view:company:carouselIdx",
    1,
  ); // 0=오늘 1=이번주 2=이번달
  const [autoRotate, setAutoRotate] = usePersistentState(
    "madup-token-monitor:view:company:autoRotate",
    true,
  );
  const [refreshing, setRefreshing] = useState(false);

  const period = RANGES[carouselIdx];
  // useCompanyLeaderboard 의 rangeToDays 와 동일 의미 — per-user RPC 가 같은 창을 보게.
  const leaderboardDays = (() => {
    const now = new Date();
    if (period === "today") return 0;
    if (period === "week") return (now.getDay() + 6) % 7;
    return now.getDate() - 1;
  })();

  // 3 면 모두 prefetch (캐시 키가 range 별로 분리되어 동시 호출 OK).
  const lbToday = useCompanyLeaderboard("today");
  const lbWeek = useCompanyLeaderboard("week");
  const lbMonth = useCompanyLeaderboard("month");
  const lbByRange: Record<LeaderboardRange, typeof lbToday> = {
    today: lbToday,
    week: lbWeek,
    month: lbMonth,
  };
  const lb = lbByRange[period];
  const mcp = useCompanyTopMcp(30);
  const plugins = useCompanyTopPlugins(30);
  // 사이드 카드 — 전사 모델 집계 RPC 가 없어 본인 7일 by_model 를 컨텍스트로 표시.
  const { data: mySummary7 } = useSummary("7d");

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["company_leaderboard"] }),
        qc.invalidateQueries({ queryKey: ["company_top_mcp"] }),
        qc.invalidateQueries({ queryKey: ["company_top_plugins"] }),
      ]);
    } finally {
      setRefreshing(false);
    }
  }

  const rows = lb.data ?? [];
  const mcpRows = mcp.data ?? [];
  const pluginRows = plugins.data ?? [];

  // KPI 합계 — leaderboard rows 에서 derive.
  const totals = useMemo(() => {
    return rows.reduce(
      (acc, r) => {
        acc.tokens += r.total_tokens;
        acc.cost += r.total_cost;
        return acc;
      },
      { tokens: 0, cost: 0 },
    );
  }, [rows]);
  const activeUsers = rows.length;
  const totalMcpCalls = mcpRows.reduce((a, r) => a + r.count, 0);
  const totalPluginUses = pluginRows.reduce((a, r) => a + r.count, 0);
  const totalCalls = totalMcpCalls + totalPluginUses;

  // 사용자별 토큰 분포 통계 (선택 기간) — 평균/최대/최소.
  const userTokenStats = useMemo(() => {
    const vals = rows.map((r) => r.total_tokens);
    if (vals.length === 0) return { avg: 0, max: 0, min: 0 };
    const sum = vals.reduce((a, b) => a + b, 0);
    return { avg: sum / vals.length, max: Math.max(...vals), min: Math.min(...vals) };
  }, [rows]);

  // 모델별 토큰 (내 7일).
  const myModelItems = useMemo(() => {
    if (!mySummary7) return [] as { label: string; value: number }[];
    return mySummary7.by_model
      .map((m) => ({
        label: m.model.replace("claude-", ""),
        value: m.input_tokens + m.output_tokens,
      }))
      .sort((a, b) => b.value - a.value);
  }, [mySummary7]);

  if (!roleAtLeast(role, "admin")) {
    return (
      <div className="px-7 pt-5 pb-8">
        <div className="mc-card p-8 text-center text-text-tertiary text-[13px]">
          사내 대시보드는 관리자(admin)만 접근할 수 있습니다.
        </div>
      </div>
    );
  }

  return (
    <div className="px-7 pt-6 pb-8">
      {/* Content head */}
      <div className="flex items-center justify-between gap-4 mb-5 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-[22px] font-bold tracking-[-0.01em] text-text-primary">
            사내 대시보드
          </h1>
          <p className="text-[12px] text-text-tertiary mt-1 whitespace-nowrap">
            매드업 전사 토큰 · MCP · 플러그인 집계 ·{" "}
            <span className="num">{activeUsers}</span>명 옵트인
          </p>
        </div>
        <div className="flex gap-2 items-center shrink-0">
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
        {/* ============ ROW 1: 4 hero KPIs ============ */}
        <KpiHero
          eyebrow={`매드업 전체 토큰 · ${PERIOD_SUFFIX[period]}`}
          value={formatTokensCompact(totals.tokens)}
          suffix="tokens"
          color="azure"
          context={
            <>
              <span className="num text-text-secondary">{activeUsers}</span>
              <span>명 합산</span>
            </>
          }
          spark={
            <Sparkline
              values={topKValues(rows.map((r) => r.total_tokens), 12).reverse()}
              width={120}
              height={50}
              color="var(--color-azure)"
              fillFrom="rgba(77,163,255,0.4)"
              fillTo="rgba(77,163,255,0)"
            />
          }
        />
        <KpiHero
          eyebrow={`전체 비용 · ${PERIOD_SUFFIX[period]}`}
          value={formatUSD(totals.cost)}
          color="amber"
          context={<span className="num">{formatKRW(totals.cost)}</span>}
          spark={
            <Sparkline
              values={topKValues(rows.map((r) => r.total_cost), 12).reverse()}
              width={120}
              height={50}
              color="var(--color-amber)"
              fillFrom="rgba(245,181,68,0.4)"
              fillTo="rgba(245,181,68,0)"
            />
          }
        />
        <KpiHero
          eyebrow="활성 사용자"
          value={String(activeUsers)}
          suffix="명 옵트인"
          color="lime"
          context={
            <>
              <span className="text-lime">●</span>
              <span>이번 기간 데이터 보유</span>
            </>
          }
          rightAccessory={<DotGrid count={activeUsers} max={16} />}
        />
        <KpiHero
          eyebrow={`MCP · 플러그인 호출 · ${PERIOD_SUFFIX[period]}`}
          value={totalCalls.toLocaleString("ko-KR")}
          suffix="건"
          color="violet"
          context={
            <>
              <span className="num text-text-secondary">{totalMcpCalls}</span>
              <span>MCP ·</span>
              <span className="num text-text-secondary">{totalPluginUses}</span>
              <span>plugin</span>
            </>
          }
          rightAccessory={
            <RingMeter
              value={Math.min(1, totalCalls / 2000)}
              size={64}
              centerLabel={`${Math.min(100, Math.round((totalCalls / 2000) * 100))}%`}
              centerColor="var(--color-violet)"
            />
          }
        />

        {/* ============ ROW 2: Leaderboard carousel (col-8) + Side card (col-4) ============ */}
        <section className="mc-card col-span-8">
          <header className="flex items-center justify-between mb-3 gap-3 relative flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[15px] font-semibold text-text-primary tracking-[-0.005em]">
                사용량 리더보드
              </span>
              <span className="text-[11.5px] text-text-tertiary whitespace-nowrap">
                {PERIOD_SUFFIX[period]} · 매드업 전사
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {/* prev / next */}
              <button
                type="button"
                onClick={() =>
                  setCarouselIdx((i) => (i + RANGES.length - 1) % RANGES.length)
                }
                aria-label="이전"
                title="이전"
                className="mc-icon-btn"
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M10 3L5 8l5 5" />
                </svg>
              </button>
              {/* range dots */}
              <div className="flex items-center gap-1.5">
                {RANGES.map((r, i) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setCarouselIdx(i)}
                    aria-label={PERIOD_SUFFIX[r]}
                    title={PERIOD_SUFFIX[r]}
                    className="w-2 h-2 rounded-full transition-colors"
                    style={{
                      background:
                        i === carouselIdx
                          ? "var(--color-azure)"
                          : "var(--color-surface-3)",
                    }}
                  />
                ))}
              </div>
              <button
                type="button"
                onClick={() => setCarouselIdx((i) => (i + 1) % RANGES.length)}
                aria-label="다음"
                title="다음"
                className="mc-icon-btn"
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M6 3l5 5-5 5" />
                </svg>
              </button>
              {/* auto-rotate toggle */}
              <button
                type="button"
                role="switch"
                aria-checked={autoRotate}
                onClick={() => setAutoRotate((v) => !v)}
                title="자동 넘기기"
                className="relative w-[34px] h-[20px] rounded-full transition-colors shrink-0 ml-1"
                style={{
                  background: autoRotate
                    ? "var(--color-azure)"
                    : "var(--color-surface-3)",
                }}
              >
                <span
                  className="absolute top-[2px] left-[2px] w-4 h-4 rounded-full transition-transform"
                  style={{
                    background: autoRotate
                      ? "#fff"
                      : "var(--color-text-secondary)",
                    transform: autoRotate
                      ? "translateX(14px)"
                      : "translateX(0)",
                  }}
                />
              </button>
              <span className="text-[11px] text-text-tertiary whitespace-nowrap">
                자동
              </span>
            </div>
          </header>

          <PrismCarousel
            activeIndex={carouselIdx}
            onIndexChange={setCarouselIdx}
            auto={autoRotate}
            intervalMs={5000}
            height={460}
            faces={RANGES.map((r) => {
              const q = lbByRange[r];
              const qrows = q.data ?? [];
              return {
                key: r,
                node: (
                  <div className="h-full pr-1">
                    {q.error && (
                      <div className="text-[12px] text-coral mb-3 px-2">
                        리더보드 RPC 실패:{" "}
                        {String(q.error?.message ?? q.error)}
                      </div>
                    )}
                    <Leaderboard
                      rows={qrows}
                      meIdentifier={user?.email ?? user?.name ?? null}
                      isLoading={q.isLoading}
                      onRowClick={(e) =>
                        navigate(`/user/${e.user_id}`, {
                          state: {
                            entry: e,
                            rangeDays: leaderboardDays,
                            periodLabel: PERIOD_SUFFIX[r],
                          },
                        })
                      }
                      footerContext={
                        qrows.length > 0
                          ? `${PERIOD_SUFFIX[r]} · ${qrows.length}명 · 행 클릭 시 상세`
                          : "집계 데이터 없음"
                      }
                    />
                  </div>
                ),
              };
            })}
          />
        </section>

        {/* Side: model breakdown (mine) + sparkline */}
        <section className="mc-card col-span-4">
          <header className="flex items-center justify-between mb-3 gap-3 relative">
            <span className="text-[15px] font-semibold text-text-primary tracking-[-0.005em]">
              내 7일 모델별 토큰
            </span>
            <span className="text-[11px] text-text-tertiary">
              로컬 · 전사 RPC 준비 중
            </span>
          </header>

          <RankBarList
            items={myModelItems}
            formatValue={(v) => formatTokensCompact(v)}
            maxRows={5}
            emptyMessage="내 사용 기록 없음"
          />

          <div
            className="mt-4 rounded-[10px] border border-hairline p-3.5"
            style={{ background: "var(--color-surface-2)" }}
          >
            <div className="text-[10.5px] font-bold tracking-[0.14em] uppercase text-text-tertiary mb-2">
              사용자별 토큰 분포 ({PERIOD_SUFFIX[period]})
            </div>
            <div className="grid grid-cols-3 gap-2 mb-3">
              <div>
                <div className="text-[9.5px] text-text-faint mb-0.5">평균</div>
                <div className="num text-[15px] font-medium text-azure">
                  {formatTokensCompact(userTokenStats.avg)}
                </div>
              </div>
              <div>
                <div className="text-[9.5px] text-text-faint mb-0.5">최대</div>
                <div className="num text-[15px] font-medium text-lime">
                  {formatTokensCompact(userTokenStats.max)}
                </div>
              </div>
              <div>
                <div className="text-[9.5px] text-text-faint mb-0.5">최소</div>
                <div className="num text-[15px] font-medium text-amber">
                  {formatTokensCompact(userTokenStats.min)}
                </div>
              </div>
            </div>
            <Sparkline
              values={
                rows.length > 0
                  ? rows
                      .slice(0, 12)
                      .map((r) => r.total_tokens)
                      .reverse()
                  : [0]
              }
              width={280}
              height={80}
              color="var(--color-azure)"
              fillFrom="rgba(77,163,255,0.35)"
              fillTo="rgba(77,163,255,0)"
              className="w-full"
            />
            <div className="text-[10.5px] num text-text-faint mt-1">
              상위 {Math.min(12, rows.length)}명
            </div>
          </div>
        </section>

        {/* ============ ROW 3: MCP TOP 10 (col-6) + Plugin TOP 10 (col-6) ============ */}
        <section className="mc-card col-span-6">
          <header className="flex items-center justify-between mb-3.5 gap-3 relative">
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-semibold text-text-primary tracking-[-0.005em]">
                사내 MCP TOP 10
              </span>
              <span className="text-[11.5px] text-text-tertiary whitespace-nowrap">
                호출 횟수 · 30일
              </span>
            </div>
          </header>
          <RankBarList
            items={mcpRows.map((m) => ({
              label: m.mcp_server,
              value: m.count,
            }))}
            formatValue={(v) => v.toLocaleString("ko-KR")}
            emptyMessage="MCP 호출 기록 없음"
          />
          <div className="flex justify-between items-center mt-4 pt-3 border-t border-hairline text-[11px] text-text-tertiary">
            <span>
              <strong className="num text-text-secondary font-semibold">
                {mcpRows.length}
              </strong>{" "}
              MCP 활성 ·{" "}
              <strong className="num text-text-secondary font-semibold">
                {totalMcpCalls.toLocaleString("ko-KR")}
              </strong>{" "}
              호출 / 30일
            </span>
          </div>
        </section>

        <section className="mc-card col-span-6">
          <header className="flex items-center justify-between mb-3.5 gap-3 relative">
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-semibold text-text-primary tracking-[-0.005em]">
                사내 플러그인 TOP 10
              </span>
              <span className="text-[11.5px] text-text-tertiary whitespace-nowrap">
                활성 사용자 수 · 30일
              </span>
            </div>
          </header>
          <RankBarList
            items={pluginRows.map((p) => ({
              label: p.plugin_id,
              value: p.count,
            }))}
            formatValue={(v) => v.toLocaleString("ko-KR")}
            emptyMessage="플러그인 사용 기록 없음"
          />
          <div className="flex justify-between items-center mt-4 pt-3 border-t border-hairline text-[11px] text-text-tertiary">
            <span>
              <strong className="num text-text-secondary font-semibold">
                {pluginRows.length}
              </strong>{" "}
              플러그인 활성 ·{" "}
              <strong className="num text-text-secondary font-semibold">
                {totalPluginUses.toLocaleString("ko-KR")}
              </strong>{" "}
              사용 / 30일
            </span>
          </div>
        </section>
      </div>

    </div>
  );
}


// =============================================================================
// Sub-components
// =============================================================================

function DotGrid({ count, max }: { count: number; max: number }) {
  const cells = Array.from({ length: max });
  return (
    <div
      className="grid gap-[5px]"
      style={{ gridTemplateColumns: "repeat(8, 8px)" }}
    >
      {cells.map((_, i) => (
        <span
          key={i}
          className="w-2 h-2 rounded-[2px]"
          style={{
            background:
              i < count ? "var(--color-lime)" : "var(--color-surface-3)",
            boxShadow:
              i < count ? "0 0 6px rgba(155,225,93,0.5)" : undefined,
          }}
        />
      ))}
    </div>
  );
}

function topKValues(values: number[], k: number): number[] {
  return [...values].sort((a, b) => b - a).slice(0, k);
}
