import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useAuthUser } from "@/hooks/useAuthUser";
import {
  fetchMyTeams,
  fetchTeamAggregates,
  fetchTeamMembersUsage,
} from "@/lib/teams";
import { formatTokensCompact, formatUSD } from "@/lib/format";
import { Leaderboard } from "@/components/charts/Leaderboard";
import { PrismCarousel } from "@/components/ui/PrismCarousel";
import { KpiHero } from "@/components/dashboard/KpiHero";
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

/// CompanyDashboard 와 동일 의미: today=0 (오늘만), week=주중 경과일, month=월중 경과일.
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

/// 내 팀 대시보드 — 전사 대시보드와 동일 UI 패턴.
/// KPI(멤버수/토큰/비용) + 기간별 멤버 리더보드 carousel.
export function MyTeamPanel() {
  const { user, myTeamIds } = useAuthUser();
  const navigate = useNavigate();
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [carouselIdx, setCarouselIdx] = useState(1); // 0=today 1=week 2=month
  const [autoRotate, setAutoRotate] = useState(true);

  const teamsQ = useQuery({
    queryKey: ["my_teams", user?.id ?? "anon"],
    queryFn: fetchMyTeams,
    enabled: !!user,
  });

  const teams: Team[] = useMemo(() => {
    if (!teamsQ.data) return [];
    return teamsQ.data.filter((t) => myTeamIds.includes(t.id));
  }, [teamsQ.data, myTeamIds]);

  useEffect(() => {
    if (!selectedTeamId && teams.length > 0) {
      setSelectedTeamId(teams[0]!.id);
    }
  }, [teams, selectedTeamId]);

  // KPI: 30일 팀 합계 (선택된 팀 1행 추출).
  const aggregatesQ = useQuery({
    queryKey: ["team_aggregates", 30],
    queryFn: () => fetchTeamAggregates(30),
    enabled: !!user,
  });
  const teamAgg = useMemo(() => {
    if (!selectedTeamId) return null;
    return aggregatesQ.data?.find((t) => t.team_id === selectedTeamId) ?? null;
  }, [aggregatesQ.data, selectedTeamId]);

  // 3 면 모두 prefetch — carousel 회전 시 즉시 표시.
  const leaderboards = useQueries({
    queries: LB_RANGES.map((r) => ({
      queryKey: ["team_members_usage_lb", selectedTeamId, r],
      queryFn: async () => {
        if (!selectedTeamId) return [] as TeamMemberUsage[];
        // get_team_members_usage 의 p_range_days = current_date - N 일 의미.
        const days = rangeToDays(r);
        // 0 일이면 오늘만 — 그러나 SQL 의 `current_date - 0 days` 는 today.
        // RPC 가 ua.date >= current_date - 0 days 로 today + 1 일 cover (≥ current_date).
        // 그래도 0 을 그대로 전달하면 today 만 반환 (정상).
        return fetchTeamMembersUsage(selectedTeamId, Math.max(days, 0));
      },
      enabled: !!selectedTeamId,
      staleTime: 60_000,
    })),
  });

  if (!user) return null;

  if (teams.length === 0) {
    return (
      <div className="mc-card p-8 text-center">
        <div className="text-text-tertiary text-[13px]">
          소속된 팀이 없습니다. 팀 리더에게 초대를 요청하세요.
        </div>
      </div>
    );
  }

  const period = LB_RANGES[carouselIdx]!;
  const periodLabel = LB_LABEL[period];
  const periodDays = rangeToDays(period);

  return (
    <div className="flex flex-col gap-6">
      {/* Team selector */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          {teams.length > 1 ? (
            <>
              <span className="text-[11px] text-text-tertiary">팀</span>
              <Select
                value={selectedTeamId ?? ""}
                onChange={(v) => setSelectedTeamId(v || null)}
                options={teams.map((t) => ({ value: t.id, label: t.name }))}
                ariaLabel="팀 선택"
              />
            </>
          ) : (
            <h2 className="text-[16px] font-semibold text-text-primary">
              {teams[0]?.name}
            </h2>
          )}
        </div>
        <label className="flex items-center gap-2 text-[11px] text-text-tertiary cursor-pointer">
          <input
            type="checkbox"
            checked={autoRotate}
            onChange={(e) => setAutoRotate(e.target.checked)}
          />
          자동 회전
        </label>
      </div>

      {/* KPI row — 30일 합계 (전사 대시보드와 동일한 hero card 패턴) */}
      <div className="grid grid-cols-12 gap-4">
        <KpiHero
          eyebrow="멤버"
          value={teamAgg ? String(teamAgg.member_count) : "—"}
          color="violet"
          colSpan={4}
        />
        <KpiHero
          eyebrow="총 토큰 · 30일"
          value={teamAgg ? formatTokensCompact(Number(teamAgg.total_tokens)) : "—"}
          color="azure"
          colSpan={4}
        />
        <KpiHero
          eyebrow="총 비용 · 30일"
          value={teamAgg ? formatUSD(Number(teamAgg.total_cost)) : "—"}
          color="amber"
          colSpan={4}
        />
      </div>

      {/* Leaderboard carousel */}
      <div className="mc-card p-4">
        <header className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <h3 className="text-[14px] font-semibold text-text-primary">
            멤버 리더보드
          </h3>
          <span className="text-[11px] text-text-tertiary">{periodLabel}</span>
        </header>
        <PrismCarousel
          activeIndex={carouselIdx}
          onIndexChange={setCarouselIdx}
          auto={autoRotate}
          intervalMs={5000}
          height={460}
          faces={LB_RANGES.map((r, i) => {
            const q = leaderboards[i]!;
            const rows = toLeaderboard((q.data ?? []) as TeamMemberUsage[]);
            return {
              key: r,
              node: (
                <div className="h-full pr-1">
                  {q.error ? (
                    <div className="text-[12px] text-coral mb-3 px-2">
                      RPC 실패: {String(q.error.message)}
                    </div>
                  ) : null}
                  <Leaderboard
                    rows={rows}
                    meIdentifier={user.email ?? user.name ?? null}
                    isLoading={q.isLoading}
                    onRowClick={(e) =>
                      navigate(`/user/${e.user_id}`, {
                        state: {
                          entry: e,
                          rangeDays: periodDays,
                          periodLabel: LB_LABEL[r],
                        },
                      })
                    }
                    footerContext={
                      rows.length > 0
                        ? `${LB_LABEL[r]} · ${rows.length}명 · 행 클릭 시 상세`
                        : "집계 데이터 없음"
                    }
                  />
                </div>
              ),
            };
          })}
        />
      </div>
    </div>
  );
}

