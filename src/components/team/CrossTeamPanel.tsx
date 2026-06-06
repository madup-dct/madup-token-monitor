import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { fetchTeamAggregates, fetchTeamMembersUsage } from "@/lib/teams";
import { usePersistentState } from "@/lib/usePersistentState";
import { KpiHero } from "@/components/dashboard/KpiHero";
import { Segmented } from "@/components/ui/Segmented";
import { useRole } from "@/hooks/useRole";
import { formatTokensCompact, formatUSD } from "@/lib/format";
import type { TeamAggregate, TeamMemberUsage } from "@/types/models";

/// 타팀 비교 대시보드 — KPI 요약 + 팀별 토큰/비용 비교 막대 + (매니저+) 팀 드릴다운.
/// team_leader 는 타팀 "총합만" 보므로 멤버 드릴다운은 manager+ 로 제한
/// (team_leader 가 타팀을 눌러도 RLS 가 멤버를 막아 빈 목록이 되는 혼란 방지).
export function CrossTeamPanel() {
  const navigate = useNavigate();
  const isManager = useRole("manager");
  const [metric, setMetric] = usePersistentState<"tokens" | "cost">(
    "madup-token-monitor:view:crossteam:metric",
    "tokens",
  );
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);

  const aggQ = useQuery({
    queryKey: ["team_aggregates", 30],
    queryFn: () => fetchTeamAggregates(30),
  });
  const teams: TeamAggregate[] = aggQ.data ?? [];

  const totals = useMemo(
    () =>
      teams.reduce(
        (acc, t) => {
          acc.tokens += Number(t.total_tokens);
          acc.cost += Number(t.total_cost);
          return acc;
        },
        { tokens: 0, cost: 0 },
      ),
    [teams],
  );

  const sorted = useMemo(
    () =>
      [...teams].sort((a, b) =>
        metric === "tokens"
          ? Number(b.total_tokens) - Number(a.total_tokens)
          : Number(b.total_cost) - Number(a.total_cost),
      ),
    [teams, metric],
  );
  const valueOf = (t: TeamAggregate) =>
    metric === "tokens" ? Number(t.total_tokens) : Number(t.total_cost);
  const maxVal = sorted.length ? valueOf(sorted[0]!) : 1;
  const fmt = (v: number) => (metric === "tokens" ? formatTokensCompact(v) : formatUSD(v));

  const membersQ = useQuery({
    queryKey: ["team_members_usage", selected?.id, 30],
    queryFn: () => fetchTeamMembersUsage(selected!.id, 30),
    enabled: !!selected && isManager,
    staleTime: 60_000,
  });
  const members: TeamMemberUsage[] = membersQ.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      {/* KPI 요약 */}
      <div className="grid grid-cols-12 gap-4">
        <KpiHero eyebrow="팀 수" value={String(teams.length)} color="violet" colSpan={4} />
        <KpiHero
          eyebrow="전체 토큰 · 30일"
          value={formatTokensCompact(totals.tokens)}
          color="azure"
          colSpan={4}
        />
        <KpiHero
          eyebrow="전체 비용 · 30일"
          value={formatUSD(totals.cost)}
          color="amber"
          colSpan={4}
        />
      </div>

      {/* 팀별 비교 */}
      <section className="mc-card">
        <header className="mb-3 flex items-center justify-between gap-3 flex-wrap">
          <span className="text-[15px] font-semibold text-text-primary">팀별 비교 · 최근 30일</span>
          <Segmented
            value={metric}
            onChange={(v) => setMetric(v as "tokens" | "cost")}
            options={[
              { value: "tokens", label: "Tokens" },
              { value: "cost", label: "Cost" },
            ]}
            ariaLabel="지표 선택"
          />
        </header>
        {aggQ.isLoading ? (
          <p className="text-[12px] text-text-tertiary py-6 text-center">로딩 중…</p>
        ) : sorted.length === 0 ? (
          <p className="text-[12px] text-text-tertiary py-6 text-center">팀 데이터 없음</p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {sorted.map((t) => {
              const val = valueOf(t);
              const pct = maxVal > 0 ? (val / maxVal) * 100 : 0;
              const active = selected?.id === t.team_id;
              const Row = (
                <>
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span className="text-[12.5px] font-semibold text-text-primary truncate">
                      {t.name}
                      <span className="text-text-tertiary font-normal text-[11px] ml-1.5">
                        {t.member_count}명
                      </span>
                    </span>
                    <span className="num text-[12px] font-medium text-azure whitespace-nowrap shrink-0">
                      {fmt(val)}
                    </span>
                  </div>
                  <div className="h-[6px] bg-surface-3 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full bg-azure-bright"
                      style={{ width: `${Math.max(2, pct)}%` }}
                    />
                  </div>
                </>
              );
              return (
                <li key={t.team_id}>
                  {isManager ? (
                    <button
                      type="button"
                      onClick={() =>
                        setSelected(active ? null : { id: t.team_id, name: t.name })
                      }
                      className={`w-full text-left rounded-md px-2 py-1.5 transition-colors ${
                        active ? "bg-azure-soft" : "hover:bg-surface-2/50"
                      }`}
                    >
                      {Row}
                    </button>
                  ) : (
                    <div className="px-2 py-1.5">{Row}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* 선택 팀 멤버 드릴다운 (manager+) */}
      {isManager && selected && (
        <section className="mc-card">
          <header className="mb-3 flex items-baseline justify-between">
            <span className="text-[15px] font-semibold text-text-primary">
              {selected.name} · 멤버
            </span>
            <span className="text-[11px] text-text-tertiary">최근 30일 · 클릭 → 상세</span>
          </header>
          {membersQ.isLoading ? (
            <p className="text-[12px] text-text-tertiary py-6 text-center">로딩 중…</p>
          ) : members.length === 0 ? (
            <p className="text-[12px] text-text-tertiary py-6 text-center">멤버 데이터 없음</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {members.map((m, i) => (
                <li key={m.user_id}>
                  <button
                    type="button"
                    onClick={() =>
                      navigate(`/user/${m.user_id}`, {
                        state: {
                          entry: {
                            rank: i + 1,
                            user_id: m.user_id,
                            display_name: m.display_name,
                            avatar_url: m.avatar_url,
                            total_cost: Number(m.total_cost),
                            total_tokens: Number(m.total_tokens),
                          },
                          rangeDays: 30,
                          periodLabel: "최근 30일",
                        },
                      })
                    }
                    className="w-full flex items-center gap-3 px-2 py-2 rounded-md text-left hover:bg-surface-2/60 transition-colors"
                  >
                    {m.avatar_url ? (
                      <img
                        src={m.avatar_url}
                        alt={m.display_name}
                        className="w-7 h-7 rounded-full object-cover shrink-0"
                      />
                    ) : (
                      <div className="w-7 h-7 rounded-full bg-surface-2 shrink-0" />
                    )}
                    <span className="flex-1 min-w-0 text-[12px] text-text-primary truncate">
                      {m.display_name}
                    </span>
                    <span className="num text-[12px] text-text-primary tabular-nums shrink-0">
                      {metric === "tokens"
                        ? formatTokensCompact(Number(m.total_tokens))
                        : formatUSD(Number(m.total_cost))}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
