import { useState } from "react";
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
import { prettyPluginId } from "@/lib/labels";
import { roleAtLeast } from "@/hooks/useRole";
import { Sparkline } from "@/components/ui/Sparkline";
import { RingMeter } from "@/components/ui/RingMeter";
import { RankBarList } from "@/components/ui/RankBarList";
import { Leaderboard } from "@/components/charts/Leaderboard";
import { PrismCarousel } from "@/components/ui/PrismCarousel";
import { CarouselControls } from "@/components/ui/CarouselControls";
import { KpiHero } from "@/components/dashboard/KpiHero";
import { DotGrid } from "@/components/ui/DotGrid";
import { formatTokensCompact, formatUSD, formatKRW } from "@/lib/format";
import { topKValues } from "@/lib/usage-math";

const RANGES: LeaderboardRange[] = ["today", "week", "month"];

const PERIOD_SUFFIX: Record<LeaderboardRange, string> = {
  today: "오늘",
  week: "이번 주",
  month: "이번 달",
};

/// 기간별 leaderboard rows → 같은 창(rangeDays) 일수. useCompanyLeaderboard 와 동일 의미.
function rangeToDays(r: LeaderboardRange): number {
  const now = new Date();
  if (r === "today") return 0;
  if (r === "week") return (now.getDay() + 6) % 7;
  return now.getDate() - 1;
}

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

  const period = RANGES[carouselIdx]!;

  // 3 면 모두 prefetch (캐시 키가 range 별로 분리되어 동시 호출 OK).
  const lbToday = useCompanyLeaderboard("today");
  const lbWeek = useCompanyLeaderboard("week");
  const lbMonth = useCompanyLeaderboard("month");
  const lbByRange: Record<LeaderboardRange, typeof lbToday> = {
    today: lbToday,
    week: lbWeek,
    month: lbMonth,
  };
  // MCP/플러그인 — 면(오늘/주/월)별 prefetch. 캐러셀 전환 시 값이 함께 바뀐다.
  const mcpToday = useCompanyTopMcp(rangeToDays("today"));
  const mcpWeek = useCompanyTopMcp(rangeToDays("week"));
  const mcpMonth = useCompanyTopMcp(rangeToDays("month"));
  const mcpByRange: Record<LeaderboardRange, typeof mcpToday> = {
    today: mcpToday,
    week: mcpWeek,
    month: mcpMonth,
  };
  const plgToday = useCompanyTopPlugins(rangeToDays("today"));
  const plgWeek = useCompanyTopPlugins(rangeToDays("week"));
  const plgMonth = useCompanyTopPlugins(rangeToDays("month"));
  const plgByRange: Record<LeaderboardRange, typeof plgToday> = {
    today: plgToday,
    week: plgWeek,
    month: plgMonth,
  };
  // 사이드 카드 — 전사 모델 집계 RPC 가 없어 본인 로컬 by_model 를 컨텍스트로 표시.
  // 면별 근사 매핑: 오늘→1d(자정부터), 주→최근 7일, 달→최근 30일 (로컬 range 의미 기준).
  const { data: mySummary1 } = useSummary("1d");
  const { data: mySummary7 } = useSummary("7d");
  const { data: mySummary30 } = useSummary("30d");
  const mySummaryByRange: Record<LeaderboardRange, typeof mySummary7> = {
    today: mySummary1,
    week: mySummary7,
    month: mySummary30,
  };
  const MY_MODEL_SUFFIX: Record<LeaderboardRange, string> = {
    today: "오늘",
    week: "최근 7일",
    month: "최근 30일",
  };

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

  // 모델별 토큰 (내 로컬) — 면별 summary 에서 derive. 캐시 포함(Dashboard 와 동일 기준).
  // <synthetic>(모델 정보 없는 내부 이벤트, 토큰 0)과 0값 모델은 TOP 자리만 차지 — 제외.
  function myModelItemsFor(r: LeaderboardRange) {
    const s = mySummaryByRange[r];
    if (!s) return [] as { label: string; value: number }[];
    return s.by_model
      .filter((m) => m.model !== "<synthetic>")
      .map((m) => ({
        label: m.model.replace("claude-", ""),
        value: m.input_tokens + m.output_tokens + m.cache_read + m.cache_write,
      }))
      .filter((m) => m.value > 0)
      .sort((a, b) => b.value - a.value);
  }

  // 기간(range)별 KPI/분포 derive — 전체 슬라이드 각 면이 자기 기간 데이터를 렌더.
  function faceData(r: LeaderboardRange) {
    const q = lbByRange[r];
    const rrows = q.data ?? [];
    const totals = rrows.reduce(
      (acc, x) => {
        acc.tokens += x.total_tokens;
        acc.cost += x.total_cost;
        return acc;
      },
      { tokens: 0, cost: 0 },
    );
    const vals = rrows.map((x) => x.total_tokens);
    const stats =
      vals.length > 0
        ? { avg: vals.reduce((a, b) => a + b, 0) / vals.length, max: Math.max(...vals), min: Math.min(...vals) }
        : { avg: 0, max: 0, min: 0 };
    return { q, rrows, totals, activeUsers: rrows.length, stats, days: rangeToDays(r) };
  }

  const headActiveUsers = (lbByRange[period].data ?? []).length;

  if (!roleAtLeast(role, "admin")) {
    return (
      <div className="px-7 pt-5 pb-8">
        <div className="mc-card p-8 text-center text-text-tertiary text-[13px]">
          사내 대시보드는 관리자(admin)만 접근할 수 있습니다.
        </div>
      </div>
    );
  }

  /// 한 기간(range)의 전체 뷰 — KPI 4 + 리더보드 + 사이드 분포 + MCP/플러그인 TOP.
  /// PrismCarousel 의 한 face 로 통째 슬라이드된다.
  function renderFace(r: LeaderboardRange) {
    const { q, rrows, totals, activeUsers, stats, days } = faceData(r);
    const label = PERIOD_SUFFIX[r];
    // MCP/플러그인/내 모델 — 면별 데이터 (캐러셀 전환 시 함께 갱신).
    const mcpRows = mcpByRange[r].data ?? [];
    const pluginRows = plgByRange[r].data ?? [];
    const totalMcpCalls = mcpRows.reduce((a, x) => a + x.count, 0);
    const totalPluginUses = pluginRows.reduce((a, x) => a + x.count, 0);
    const totalCalls = totalMcpCalls + totalPluginUses;
    const myModelItems = myModelItemsFor(r);
    return (
      <div className="grid grid-cols-12 gap-4 pr-1 pb-1">
        {/* ROW 1: 4 hero KPIs */}
        <KpiHero
          eyebrow={`매드업 전체 토큰 · ${label}`}
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
              values={topKValues(rrows.map((x) => x.total_tokens), 12).reverse()}
              width={120}
              height={50}
              color="var(--color-azure)"
              fillFrom="rgba(77,163,255,0.4)"
              fillTo="rgba(77,163,255,0)"
            />
          }
        />
        <KpiHero
          eyebrow={`전체 비용 · ${label}`}
          value={formatUSD(totals.cost)}
          color="amber"
          context={<span className="num">{formatKRW(totals.cost)}</span>}
          spark={
            <Sparkline
              values={topKValues(rrows.map((x) => x.total_cost), 12).reverse()}
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
          eyebrow={`MCP · 플러그인 호출 · ${label}`}
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

        {/* ROW 2: 리더보드 (col-8) + 사이드 분포 (col-4) */}
        <section className="mc-card col-span-8">
          <header className="flex items-center justify-between mb-3 gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[15px] font-semibold text-text-primary tracking-[-0.005em]">
                사용량 리더보드
              </span>
              <span className="text-[11.5px] text-text-tertiary whitespace-nowrap">
                {label} · 매드업 전사
              </span>
            </div>
          </header>
          {q.error && (
            <div className="text-[12px] text-coral mb-3 px-2">
              리더보드 RPC 실패: {String(q.error?.message ?? q.error)}
            </div>
          )}
          <Leaderboard
            rows={rrows}
            meIdentifier={user?.email ?? user?.name ?? null}
            isLoading={q.isLoading}
            onRowClick={(e) =>
              navigate(`/user/${e.user_id}`, {
                state: { entry: e, rangeDays: days, periodLabel: label },
              })
            }
            footerContext={
              rrows.length > 0
                ? `${label} · ${rrows.length}명 · 행 클릭 시 상세`
                : "집계 데이터 없음"
            }
          />
        </section>

        <section className="mc-card col-span-4">
          <header className="flex items-center justify-between mb-3 gap-3 relative">
            <span className="text-[15px] font-semibold text-text-primary tracking-[-0.005em]">
              내 모델별 토큰
            </span>
            <span className="text-[11px] text-text-tertiary">
              내 로컬 · {MY_MODEL_SUFFIX[r]}
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
              사용자별 토큰 분포 ({label})
            </div>
            <div className="grid grid-cols-3 gap-2 mb-3">
              <div>
                <div className="text-[9.5px] text-text-faint mb-0.5">평균</div>
                <div className="num text-[15px] font-medium text-azure">
                  {formatTokensCompact(stats.avg)}
                </div>
              </div>
              <div>
                <div className="text-[9.5px] text-text-faint mb-0.5">최대</div>
                <div className="num text-[15px] font-medium text-lime">
                  {formatTokensCompact(stats.max)}
                </div>
              </div>
              <div>
                <div className="text-[9.5px] text-text-faint mb-0.5">최소</div>
                <div className="num text-[15px] font-medium text-amber">
                  {formatTokensCompact(stats.min)}
                </div>
              </div>
            </div>
            <Sparkline
              values={
                rrows.length > 0
                  ? rrows.slice(0, 12).map((x) => x.total_tokens).reverse()
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
              상위 {Math.min(12, rrows.length)}명
            </div>
          </div>
        </section>

        {/* ROW 3: 사내 MCP TOP 10 (col-6) + 플러그인 TOP 10 (col-6) — 면별 기간 연동 */}
        {/* flex-col + foot mt-auto — 행 수가 달라도 두 카드의 foot 요약이 하단에 정렬 */}
        <section className="mc-card col-span-6 flex flex-col">
          <header className="flex items-center justify-between mb-3.5 gap-3 relative">
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-semibold text-text-primary tracking-[-0.005em]">
                사내 MCP TOP 10
              </span>
              <span className="text-[11.5px] text-text-tertiary whitespace-nowrap">호출 횟수 · {label}</span>
            </div>
          </header>
          <RankBarList
            className="flex-1"
            items={mcpRows.map((m) => ({ label: m.mcp_server, value: m.count }))}
            formatValue={(v) => v.toLocaleString("ko-KR")}
            emptyMessage="MCP 호출 기록 없음"
          />
          <div className="flex justify-between items-center mt-4 pt-3 border-t border-hairline text-[11px] text-text-tertiary">
            <span>
              <strong className="num text-text-secondary font-semibold">{mcpRows.length}</strong> MCP 활성 ·{" "}
              <strong className="num text-text-secondary font-semibold">
                {totalMcpCalls.toLocaleString("ko-KR")}
              </strong>{" "}
              호출 / {label}
            </span>
          </div>
        </section>

        <section className="mc-card col-span-6 flex flex-col">
          <header className="flex items-center justify-between mb-3.5 gap-3 relative">
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-semibold text-text-primary tracking-[-0.005em]">
                사내 플러그인 TOP 10
              </span>
              <span className="text-[11.5px] text-text-tertiary whitespace-nowrap">활성 사용자 수 · {label}</span>
            </div>
          </header>
          <RankBarList
            className="flex-1"
            items={pluginRows.map((p) => ({
              label: prettyPluginId(p.plugin_id),
              title: p.plugin_id,
              value: p.count,
            }))}
            formatValue={(v) => v.toLocaleString("ko-KR")}
            emptyMessage="플러그인 사용 기록 없음"
          />
          <div className="flex justify-between items-center mt-4 pt-3 border-t border-hairline text-[11px] text-text-tertiary">
            <span>
              <strong className="num text-text-secondary font-semibold">{pluginRows.length}</strong> 플러그인 활성 ·{" "}
              <strong className="num text-text-secondary font-semibold">
                {totalPluginUses.toLocaleString("ko-KR")}
              </strong>{" "}
              사용 / {label}
            </span>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="px-7 pt-6 pb-8">
      {/* Content head — 제목 + 새로고침 + 기간 캐러셀 컨트롤(전체 슬라이드) */}
      <div className="flex items-center justify-between gap-4 mb-5 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-[22px] font-bold tracking-[-0.01em] text-text-primary">사내 대시보드</h1>
          <p className="text-[12px] text-text-tertiary mt-1 whitespace-nowrap">
            매드업 전사 토큰 · MCP · 플러그인 집계 · {PERIOD_SUFFIX[period]} ·{" "}
            <span className="num">{headActiveUsers}</span>명 옵트인
          </p>
        </div>
        <div className="flex gap-3 items-center shrink-0">
          <CarouselControls
            count={RANGES.length}
            activeIndex={carouselIdx}
            onIndexChange={setCarouselIdx}
            labels={RANGES.map((r) => PERIOD_SUFFIX[r])}
            auto={autoRotate}
            onAutoChange={setAutoRotate}
          />
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

      {/* 전체 슬라이드 — 기간 전환 시 KPI·리더보드·사이드·MCP/플러그인이 함께 회전 */}
      <PrismCarousel
        activeIndex={carouselIdx}
        onIndexChange={setCarouselIdx}
        auto={autoRotate}
        intervalMs={7000}
        height={680}
        faces={RANGES.map((r) => ({ key: r, node: renderFace(r) }))}
      />
    </div>
  );
}
