import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useAuthUser } from "@/hooks/useAuthUser";
import { roleAtLeast } from "@/hooks/useRole";
import {
  fetchMyMemberships,
  fetchMyTeams,
  fetchTeamAggregates,
  fetchTeamMcp,
  fetchTeamMembersUsage,
  fetchTeamPlugins,
  fetchTeamTopModels,
  leaveTeam,
} from "@/lib/teams";
import type { TeamTopModel } from "@/lib/teams";
import { formatTokensCompact, formatUSD, formatKRW } from "@/lib/format";
import { topKValues } from "@/lib/usage-math";
import { prettyPluginId } from "@/lib/labels";
import { usePersistentState } from "@/lib/usePersistentState";
import { Leaderboard } from "@/components/charts/Leaderboard";
import { PrismCarousel } from "@/components/ui/PrismCarousel";
import { CarouselControls } from "@/components/ui/CarouselControls";
import { KpiHero } from "@/components/dashboard/KpiHero";
import { DotGrid } from "@/components/ui/DotGrid";
import { RingMeter } from "@/components/ui/RingMeter";
import { RankBarList } from "@/components/ui/RankBarList";
import { Sparkline } from "@/components/ui/Sparkline";
import { Select } from "@/components/ui/Select";
import type { Team, TeamMemberUsage } from "@/types/models";
import type { CompanyLeaderboardEntry } from "@/hooks/useUsage";

type LBRange = "today" | "week" | "month";
const LB_RANGES: LBRange[] = ["today", "week", "month"];
const LB_LABEL: Record<LBRange, string> = {
  today: "오늘",
  week: "이번 주",
  month: "이번 달",
};

const MCP_PLUGIN_DAYS = 30;

/// CompanyDashboard 와 동일 의미: today=0(오늘만), week=주중 경과일, month=월중 경과일.
function rangeToDays(r: LBRange): number {
  const d = new Date();
  if (r === "today") return 0;
  if (r === "week") return (d.getDay() + 6) % 7;
  return d.getDate() - 1;
}

function toLeaderboard(rows: TeamMemberUsage[]): CompanyLeaderboardEntry[] {
  return rows
    .slice()
    .sort((a, b) => Number(b.total_tokens) - Number(a.total_tokens))
    .map((r, i) => ({
      rank: i + 1,
      user_id: r.user_id,
      display_name: r.display_name,
      avatar_url: r.avatar_url,
      total_cost: Number(r.total_cost),
      total_tokens: Number(r.total_tokens),
    }));
}

/// 내 팀 대시보드 — 사내 대시보드와 동일한 뷰(KPI hero + 멤버 리더보드 + 팀 MCP/플러그인 TOP).
/// 기간(오늘/주/월) 전환 시 전체가 한 face 로 함께 슬라이드된다.
/// 접근 제어: admin 은 전체 팀, 비-admin(팀리드 포함)은 본인 소속 팀만.
export function MyTeamPanel() {
  const { user, role, myTeamIds } = useAuthUser();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isAdmin = roleAtLeast(role, "admin");

  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [carouselIdx, setCarouselIdx] = usePersistentState(
    "madup-token-monitor:view:myteam:carouselIdx",
    1,
  ); // 0=today 1=week 2=month
  const [autoRotate, setAutoRotate] = usePersistentState(
    "madup-token-monitor:view:myteam:autoRotate",
    true,
  );
  const [refreshing, setRefreshing] = useState(false);

  // fetchMyTeams = RLS 허용 전체 teams. admin 은 전체, 비-admin 은 본인 소속만으로 클라이언트 필터.
  const teamsQ = useQuery({
    queryKey: ["my_teams", user?.id ?? "anon"],
    queryFn: fetchMyTeams,
    enabled: !!user,
  });

  const membershipsQ = useQuery({
    queryKey: ["my_memberships", user?.id ?? "anon"],
    queryFn: fetchMyMemberships,
    enabled: !!user,
  });
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const leaveMut = useMutation({
    mutationFn: (teamId: string) => leaveTeam(teamId),
    onSuccess: () => {
      setConfirmLeave(false);
      setLeaveError(null);
      qc.invalidateQueries({ queryKey: ["my_teams"] });
      qc.invalidateQueries({ queryKey: ["my_memberships"] });
      qc.invalidateQueries({ queryKey: ["team_aggregates"] });
    },
    onError: (e) => setLeaveError(e instanceof Error ? e.message : String(e)),
  });

  const teams: Team[] = useMemo(() => {
    const all = teamsQ.data ?? [];
    return isAdmin ? all : all.filter((t) => myTeamIds.includes(t.id));
  }, [teamsQ.data, myTeamIds, isAdmin]);

  useEffect(() => {
    if (teams.length === 0) {
      if (selectedTeamId !== null) setSelectedTeamId(null);
      return;
    }
    if (!selectedTeamId || !teams.some((t) => t.id === selectedTeamId)) {
      setSelectedTeamId(teams[0]!.id);
    }
  }, [teams, selectedTeamId]);

  const period = LB_RANGES[carouselIdx]!;
  const periodLabel = LB_LABEL[period];

  // 팀 멤버 수(30일 집계 기준).
  const aggregatesQ = useQuery({
    queryKey: ["team_aggregates", MCP_PLUGIN_DAYS],
    queryFn: () => fetchTeamAggregates(MCP_PLUGIN_DAYS),
    enabled: !!user,
  });
  const teamAgg = useMemo(() => {
    if (!selectedTeamId) return null;
    return aggregatesQ.data?.find((t) => t.team_id === selectedTeamId) ?? null;
  }, [aggregatesQ.data, selectedTeamId]);

  // 3 면(오늘/주/월) 멤버 사용량 prefetch — carousel 회전 시 즉시 표시.
  const leaderboards = useQueries({
    queries: LB_RANGES.map((r) => ({
      queryKey: ["team_members_usage_lb", selectedTeamId, r],
      queryFn: async () => {
        if (!selectedTeamId) return [] as TeamMemberUsage[];
        return fetchTeamMembersUsage(selectedTeamId, Math.max(rangeToDays(r), 0));
      },
      enabled: !!selectedTeamId,
      staleTime: 60_000,
    })),
  });

  // 3 면(오늘/주/월) 사용 모델 TOP5 prefetch — RPC 미적용/에러 시에도 카드가 죽지 않게
  // retry 없이 빈 배열로 처리 (렌더에서 data ?? []).
  const topModelsQs = useQueries({
    queries: LB_RANGES.map((r) => ({
      queryKey: ["team_top_models", selectedTeamId, rangeToDays(r)],
      queryFn: async () => {
        if (!selectedTeamId) return [] as TeamTopModel[];
        return fetchTeamTopModels(selectedTeamId, rangeToDays(r));
      },
      enabled: !!selectedTeamId,
      staleTime: 60_000,
      retry: 0,
    })),
  });

  // 팀 MCP / 플러그인 TOP — 면(오늘/주/월)별 prefetch. 캐러셀 전환 시 값이 함께 바뀐다.
  const mcpQs = useQueries({
    queries: LB_RANGES.map((r) => ({
      queryKey: ["team_mcp", selectedTeamId, rangeToDays(r)],
      queryFn: () => fetchTeamMcp(selectedTeamId!, rangeToDays(r)),
      enabled: !!selectedTeamId,
      staleTime: 60_000,
    })),
  });
  const pluginQs = useQueries({
    queries: LB_RANGES.map((r) => ({
      queryKey: ["team_plugins", selectedTeamId, rangeToDays(r)],
      queryFn: () => fetchTeamPlugins(selectedTeamId!, rangeToDays(r)),
      enabled: !!selectedTeamId,
      staleTime: 60_000,
    })),
  });

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["team_aggregates"] }),
        qc.invalidateQueries({ queryKey: ["team_members_usage_lb"] }),
        qc.invalidateQueries({ queryKey: ["team_mcp"] }),
        qc.invalidateQueries({ queryKey: ["team_plugins"] }),
        qc.invalidateQueries({ queryKey: ["team_top_models"] }),
      ]);
    } finally {
      setRefreshing(false);
    }
  }

  const memberCount = teamAgg ? Number(teamAgg.member_count) : 0;

  const selectedTeam = teams.find((t) => t.id === selectedTeamId) ?? null;

  const myRoleInSelected =
    (membershipsQ.data ?? []).find((m) => m.team_id === selectedTeamId)?.role ?? null;
  const canLeaveSelected = myRoleInSelected !== null && myRoleInSelected !== "owner";

  // 기간(index)별 멤버 derive — 전체 슬라이드 각 면이 자기 기간 데이터를 렌더.
  function faceData(i: number) {
    const q = leaderboards[i]!;
    const rows = toLeaderboard((q.data ?? []) as TeamMemberUsage[]);
    const totals = rows.reduce(
      (acc, r) => {
        acc.tokens += r.total_tokens;
        acc.cost += r.total_cost;
        return acc;
      },
      { tokens: 0, cost: 0 },
    );
    const vals = rows.map((r) => r.total_tokens).filter((v) => v > 0);
    const stats =
      vals.length > 0
        ? { avg: vals.reduce((a, b) => a + b, 0) / vals.length, max: Math.max(...vals), min: Math.min(...vals) }
        : { avg: 0, max: 0, min: 0 };
    return { q, rows, totals, activeMembers: vals.length, stats, days: rangeToDays(LB_RANGES[i]!) };
  }

  if (!user) return null;

  if (teams.length === 0) {
    return (
      <div className="mc-card p-8 text-center">
        <div className="text-text-tertiary text-[13px]">
          {isAdmin
            ? "표시할 팀이 없습니다. 팀 관리에서 팀을 먼저 생성하세요."
            : "소속된 팀이 없습니다. 팀 리더에게 초대를 요청하세요."}
        </div>
      </div>
    );
  }

  /// 한 기간의 전체 뷰 — KPI 4 + 멤버 리더보드 + 사용 모델 TOP5·토큰 분포 + 팀 MCP/플러그인 TOP.
  function renderFace(r: LBRange, i: number) {
    const { q, rows, totals, activeMembers, stats, days } = faceData(i);
    const label = LB_LABEL[r];
    const topModelsQ = topModelsQs[i]!;
    // RPC 미적용/에러 시 빈 배열 → 카드 전체가 죽지 않고 빈 상태 메시지만 표시.
    const topModels = (topModelsQ.data ?? []) as TeamTopModel[];
    // MCP/플러그인 — 면별 쿼리 (캐러셀 전환 시 함께 갱신).
    const mcpQ = mcpQs[i]!;
    const pluginQ = pluginQs[i]!;
    const mcpRows = mcpQ.data ?? [];
    const pluginRows = pluginQ.data ?? [];
    const totalMcpCalls = mcpRows.reduce((a, r) => a + r.count, 0);
    const totalPluginUses = pluginRows.reduce((a, r) => a + r.count, 0);
    const totalCalls = totalMcpCalls + totalPluginUses;
    return (
      <div className="grid grid-cols-12 gap-4 pr-1 pb-1">
        {/* ROW 1: 4 hero KPIs */}
        <KpiHero
          eyebrow={`팀 토큰 · ${label}`}
          value={formatTokensCompact(totals.tokens)}
          suffix="tokens"
          color="azure"
          context={
            <>
              <span className="num text-text-secondary">{activeMembers}</span>
              <span>명 합산</span>
            </>
          }
          spark={
            <Sparkline
              values={topKValues(rows.map((x) => x.total_tokens), 12).reverse()}
              width={120}
              height={50}
              color="var(--color-azure)"
              fillFrom="rgba(77,163,255,0.4)"
              fillTo="rgba(77,163,255,0)"
            />
          }
        />
        <KpiHero
          eyebrow={`팀 비용 · ${label}`}
          value={formatUSD(totals.cost)}
          color="amber"
          context={<span className="num">{formatKRW(totals.cost)}</span>}
          spark={
            <Sparkline
              values={topKValues(rows.map((x) => x.total_cost), 12).reverse()}
              width={120}
              height={50}
              color="var(--color-amber)"
              fillFrom="rgba(245,181,68,0.4)"
              fillTo="rgba(245,181,68,0)"
            />
          }
        />
        <KpiHero
          eyebrow="활성 멤버"
          value={String(activeMembers)}
          suffix={`/ ${memberCount}명`}
          color="lime"
          context={
            <>
              <span className="text-lime">●</span>
              <span>이번 기간 데이터 보유</span>
            </>
          }
          rightAccessory={<DotGrid count={activeMembers} max={16} />}
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

        {/* ROW 2: 멤버 리더보드 (col-8) + 사용 모델 TOP5 · 멤버 토큰 분포 (col-4) */}
        <section className="mc-card col-span-8">
          <header className="flex items-center justify-between mb-3 gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[15px] font-semibold text-text-primary tracking-[-0.005em]">
                멤버 리더보드
              </span>
              <span className="text-[11.5px] text-text-tertiary whitespace-nowrap">
                {label} · {selectedTeam?.name ?? "팀"} 내 TOP
              </span>
            </div>
          </header>
          {q.error ? (
            <div className="text-[12px] text-coral mb-3 px-2">RPC 실패: {String(q.error.message)}</div>
          ) : null}
          <Leaderboard
            rows={rows}
            meIdentifier={user!.email ?? user!.name ?? null}
            isLoading={q.isLoading}
            onRowClick={(e) =>
              navigate(`/user/${e.user_id}`, {
                state: { entry: e, rangeDays: days, periodLabel: label },
              })
            }
            footerContext={
              rows.length > 0 ? `${label} · ${rows.length}명 · 행 클릭 시 상세` : "집계 데이터 없음"
            }
          />
        </section>

        <section className="mc-card col-span-4">
          <header className="flex items-center justify-between mb-3 gap-3 relative">
            <span className="text-[15px] font-semibold text-text-primary tracking-[-0.005em]">
              사용 모델 TOP5
            </span>
            <span className="text-[11px] text-text-tertiary">토큰 기준 · {label}</span>
          </header>
          {topModelsQ.error ? (
            // 형제 카드(MCP/플러그인)와 동일 — RPC 에러가 '기록 없음' 빈 상태로 위장되지 않게.
            <div className="text-[12px] text-coral mb-2 px-1">
              RPC 실패: {String((topModelsQ.error as Error).message)}
            </div>
          ) : null}
          <RankBarList
            items={topModels.map((m) => ({
              label: m.model.replace("claude-", ""),
              value: m.totalTokens,
            }))}
            formatValue={(v) => formatTokensCompact(v)}
            maxRows={5}
            emptyMessage={
              topModelsQ.isLoading ? "로딩 중…" : `팀 모델 사용 기록 없음 (${label})`
            }
          />
          <div
            className="mt-4 rounded-[10px] border border-hairline p-3.5"
            style={{ background: "var(--color-surface-2)" }}
          >
            <div className="text-[10.5px] font-bold tracking-[0.14em] uppercase text-text-tertiary mb-2">
              멤버별 토큰 ({label})
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
              values={rows.length > 0 ? rows.slice(0, 12).map((x) => x.total_tokens).reverse() : [0]}
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

        {/* ROW 3: 팀 MCP TOP (col-6) + 팀 플러그인 TOP (col-6) — 면별 기간 연동 */}
        <section className="mc-card col-span-6">
          <header className="flex items-center justify-between mb-3.5 gap-3 relative">
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-semibold text-text-primary tracking-[-0.005em]">팀 MCP TOP</span>
              <span className="text-[11.5px] text-text-tertiary whitespace-nowrap">호출 횟수 · {label}</span>
            </div>
          </header>
          {mcpQ.error ? (
            <div className="text-[12px] text-coral mb-2 px-1">RPC 실패: {String(mcpQ.error.message)}</div>
          ) : null}
          <RankBarList
            items={mcpRows.map((m) => ({ label: m.label, value: m.count }))}
            formatValue={(v) => v.toLocaleString("ko-KR")}
            emptyMessage={mcpQ.isLoading ? "로딩 중…" : `팀 MCP 호출 기록 없음 (${label})`}
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

        <section className="mc-card col-span-6">
          <header className="flex items-center justify-between mb-3.5 gap-3 relative">
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-semibold text-text-primary tracking-[-0.005em]">팀 플러그인 TOP</span>
              <span className="text-[11.5px] text-text-tertiary whitespace-nowrap">활성 사용자 수 · {label}</span>
            </div>
          </header>
          {pluginQ.error ? (
            <div className="text-[12px] text-coral mb-2 px-1">RPC 실패: {String(pluginQ.error.message)}</div>
          ) : null}
          <RankBarList
            items={pluginRows.map((p) => ({
              label: prettyPluginId(p.label),
              title: p.label,
              value: p.count,
            }))}
            formatValue={(v) => v.toLocaleString("ko-KR")}
            emptyMessage={pluginQ.isLoading ? "로딩 중…" : `팀 플러그인 사용 기록 없음 (${label})`}
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
    <div className="grid grid-cols-1 gap-4">
      {/* Content head — 제목 + 팀 선택 + 기간 캐러셀 컨트롤(전체 슬라이드) + 새로고침 */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-[22px] font-bold tracking-[-0.01em] text-text-primary">내 팀 대시보드</h1>
          <p className="text-[12px] text-text-tertiary mt-1 whitespace-nowrap">
            {selectedTeam ? `${selectedTeam.name} · ` : ""}
            {periodLabel} · <span className="num">{memberCount}</span>명 멤버
            {isAdmin ? " · 전체 팀 열람(admin)" : ""}
          </p>
        </div>
        <div className="flex gap-3 items-center shrink-0 flex-wrap">
          {teams.length > 1 ? (
            <Select
              value={selectedTeamId ?? ""}
              onChange={(v) => setSelectedTeamId(v || null)}
              options={teams.map((t) => ({ value: t.id, label: t.name }))}
              ariaLabel="팀 선택"
            />
          ) : null}
          <CarouselControls
            count={LB_RANGES.length}
            activeIndex={carouselIdx}
            onIndexChange={setCarouselIdx}
            labels={LB_RANGES.map((r) => LB_LABEL[r])}
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
          {canLeaveSelected ? (
            confirmLeave ? (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={leaveMut.isPending}
                  onClick={() => selectedTeamId && leaveMut.mutate(selectedTeamId)}
                  className="px-3 py-1.5 rounded-md bg-rose-500/20 text-rose-200 text-[12px] font-semibold disabled:opacity-50"
                >
                  {leaveMut.isPending ? "나가는 중…" : "정말 나가기"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmLeave(false)}
                  className="px-3 py-1.5 rounded-md bg-surface-2 text-text-secondary text-[12px] font-semibold"
                >
                  취소
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmLeave(true)}
                className="px-3 py-1.5 rounded-md bg-surface-2 text-text-tertiary hover:text-rose-300 text-[12px] font-semibold"
              >
                팀 나가기
              </button>
            )
          ) : null}
        </div>
      </div>

      {leaveError ? (
        <div className="text-[12px] text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-md px-3 py-2">
          {leaveError}
        </div>
      ) : null}

      {/* 전체 슬라이드 — 기간 전환 시 KPI·리더보드·분포·MCP/플러그인이 함께 회전 */}
      <PrismCarousel
        activeIndex={carouselIdx}
        onIndexChange={setCarouselIdx}
        auto={autoRotate}
        intervalMs={7000}
        height={680}
        faces={LB_RANGES.map((r, i) => ({ key: r, node: renderFace(r, i) }))}
      />
    </div>
  );
}
