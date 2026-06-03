import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useAuthUser } from "@/hooks/useAuthUser";
import {
  fetchTeamAggregates,
  fetchTeamMcp,
  fetchTeamMembersUsage,
  fetchTeamPlugins,
} from "@/lib/teams";
import { formatTokensCompact, formatUSD } from "@/lib/format";
import { KpiHero } from "@/components/dashboard/KpiHero";
import { CarouselCard } from "@/components/dashboard/CarouselCard";
import { RankBarList } from "@/components/ui/RankBarList";
import { Leaderboard } from "@/components/charts/Leaderboard";
import type { TeamMemberUsage } from "@/types/models";
import type { CompanyLeaderboardEntry } from "@/hooks/useUsage";

const RANGE_DAYS = 30;

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

/// 한 팀의 대시보드 — KPI(멤버/토큰/비용) + 멤버 리더보드 + 팀 MCP/플러그인 carousel.
/// "내 팀 목록 > 팀 클릭" 드릴다운에서 사용. 30일 고정 기준.
export function TeamDashboardPanel({ teamId }: { teamId: string }) {
  const { user } = useAuthUser();
  const navigate = useNavigate();

  const aggQ = useQuery({
    queryKey: ["team_aggregates", RANGE_DAYS],
    queryFn: () => fetchTeamAggregates(RANGE_DAYS),
    enabled: !!user,
  });
  const agg = (aggQ.data ?? []).find((t) => t.team_id === teamId) ?? null;

  const membersQ = useQuery({
    queryKey: ["team_members_usage", teamId, RANGE_DAYS],
    queryFn: () => fetchTeamMembersUsage(teamId, RANGE_DAYS),
    enabled: !!teamId,
    staleTime: 60_000,
  });
  const mcpQ = useQuery({
    queryKey: ["team_mcp", teamId, RANGE_DAYS],
    queryFn: () => fetchTeamMcp(teamId, RANGE_DAYS),
    enabled: !!teamId,
    staleTime: 60_000,
  });
  const pluginQ = useQuery({
    queryKey: ["team_plugins", teamId, RANGE_DAYS],
    queryFn: () => fetchTeamPlugins(teamId, RANGE_DAYS),
    enabled: !!teamId,
    staleTime: 60_000,
  });

  const rows = toLeaderboard((membersQ.data ?? []) as TeamMemberUsage[]);

  return (
    <div className="flex flex-col gap-4">
      {/* KPI */}
      <div className="grid grid-cols-12 gap-4">
        <KpiHero
          eyebrow="멤버"
          value={agg ? String(agg.member_count) : "—"}
          color="violet"
          colSpan={4}
        />
        <KpiHero
          eyebrow="총 토큰 · 30일"
          value={agg ? formatTokensCompact(Number(agg.total_tokens)) : "—"}
          color="azure"
          colSpan={4}
        />
        <KpiHero
          eyebrow="총 비용 · 30일"
          value={agg ? formatUSD(Number(agg.total_cost)) : "—"}
          color="amber"
          colSpan={4}
        />
      </div>

      {/* 멤버 리더보드 (col-8) + 팀 MCP/플러그인 carousel (col-4) */}
      <div className="grid grid-cols-12 gap-4">
        <section className="mc-card col-span-8">
          <header className="flex items-center justify-between mb-3 gap-3">
            <span className="text-[15px] font-semibold text-text-primary tracking-[-0.005em]">
              멤버 리더보드
            </span>
            <span className="text-[11px] text-text-tertiary">최근 30일 · 팀 내 TOP</span>
          </header>
          {membersQ.error ? (
            <div className="text-[12px] text-coral mb-3 px-1">
              RPC 실패: {String(membersQ.error.message)}
            </div>
          ) : null}
          <Leaderboard
            rows={rows}
            meIdentifier={user?.email ?? user?.name ?? null}
            isLoading={membersQ.isLoading}
            onRowClick={(e) =>
              navigate(`/user/${e.user_id}`, {
                state: { entry: e, rangeDays: RANGE_DAYS, periodLabel: "최근 30일" },
              })
            }
            footerContext={
              rows.length > 0
                ? `${rows.length}명 · 행 클릭 시 상세`
                : "집계 데이터 없음"
            }
          />
        </section>

        <CarouselCard
          className="col-span-4"
          height={360}
          faces={[
            {
              key: "mcp",
              title: "팀 MCP 사용량",
              subtitle: "최근 30일",
              node: (
                <div className="h-full pr-1">
                  {mcpQ.error ? (
                    <div className="text-[12px] text-coral mb-2 px-1">
                      RPC 실패: {String(mcpQ.error.message)}
                    </div>
                  ) : null}
                  <RankBarList
                    items={(mcpQ.data ?? []).map((r) => ({ label: r.label, value: r.count }))}
                    formatValue={(v) => v.toLocaleString("ko-KR")}
                    emptyMessage={mcpQ.isLoading ? "로딩 중…" : "팀 MCP 기록 없음 (최근 30일)"}
                  />
                </div>
              ),
            },
            {
              key: "plugins",
              title: "팀 플러그인 사용량",
              subtitle: "최근 30일",
              node: (
                <div className="h-full pr-1">
                  {pluginQ.error ? (
                    <div className="text-[12px] text-coral mb-2 px-1">
                      RPC 실패: {String(pluginQ.error.message)}
                    </div>
                  ) : null}
                  <RankBarList
                    items={(pluginQ.data ?? []).map((r) => ({ label: r.label, value: r.count }))}
                    formatValue={(v) => v.toLocaleString("ko-KR")}
                    emptyMessage={pluginQ.isLoading ? "로딩 중…" : "팀 플러그인 기록 없음 (최근 30일)"}
                  />
                </div>
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}
