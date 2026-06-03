import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  createTeam,
  fetchMyTeams,
  fetchTeamAggregates,
  fetchTeamMembers,
  inviteToTeam,
} from "@/lib/teams";
import { useAuthUser } from "@/hooks/useAuthUser";
import { formatTokensCompact, formatUSD } from "@/lib/format";
import { TeamDashboardPanel } from "@/components/team/TeamDashboardPanel";
import type { Team } from "@/types/models";

/// 팀 관리 — 리스트 뷰 + 드릴다운 뷰.
/// URL: /team?tab=manage (리스트) 또는 /team?tab=manage&team=:id (상세).
export function TeamManageList() {
  const [params, setParams] = useSearchParams();
  const teamId = params.get("team");

  function goTo(nextTeamId: string | null) {
    const p = new URLSearchParams(params);
    if (nextTeamId) p.set("team", nextTeamId);
    else p.delete("team");
    setParams(p, { replace: true });
  }

  return teamId ? (
    <TeamDetail teamId={teamId} onBack={() => goTo(null)} />
  ) : (
    <TeamListView onSelect={(id) => goTo(id)} />
  );
}

// =============================================================================
// 리스트 뷰
// =============================================================================
function TeamListView({ onSelect }: { onSelect: (teamId: string) => void }) {
  const qc = useQueryClient();
  const { user, myTeamIds } = useAuthUser();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);

  const teamsQ = useQuery({
    queryKey: ["my_teams", user?.id ?? "anon"],
    queryFn: fetchMyTeams,
    enabled: !!user,
  });
  const aggsQ = useQuery({
    queryKey: ["team_aggregates", 30],
    queryFn: () => fetchTeamAggregates(30),
    enabled: !!user,
  });

  const teams: Team[] = useMemo(() => {
    if (!teamsQ.data) return [];
    return teamsQ.data.filter((t) => myTeamIds.includes(t.id));
  }, [teamsQ.data, myTeamIds]);

  const aggById = useMemo(() => {
    const map = new Map<string, { member_count: number; total_tokens: number; total_cost: number }>();
    for (const a of aggsQ.data ?? []) {
      map.set(a.team_id, {
        member_count: Number(a.member_count),
        total_tokens: Number(a.total_tokens),
        total_cost: Number(a.total_cost),
      });
    }
    return map;
  }, [aggsQ.data]);

  const createMut = useMutation({
    mutationFn: () => createTeam(name.trim(), slug.trim()),
    onSuccess: (t) => {
      setName("");
      setSlug("");
      setShowCreate(false);
      setError(null);
      qc.invalidateQueries({ queryKey: ["my_teams"] });
      qc.invalidateQueries({ queryKey: ["team_aggregates"] });
      onSelect(t.id);
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-[16px] font-semibold text-text-primary">내 팀 목록</h2>
        <button
          type="button"
          onClick={() => setShowCreate((v) => !v)}
          className="px-3 py-1.5 rounded-md bg-azure-bright text-[12px] font-semibold text-[#06122b]"
        >
          {showCreate ? "취소" : "+ 새 팀"}
        </button>
      </div>

      {error ? (
        <div className="text-[12px] text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-md px-3 py-2">
          {error}
        </div>
      ) : null}

      {/* 새 팀 만들기 폼 */}
      {showCreate ? (
        <div className="mc-card p-4 flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1 flex-1 min-w-[180px]">
            <label className="text-[11px] text-text-tertiary">팀 이름</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="예: 광고팀"
              className="px-3 py-2 rounded-md bg-surface-1 border border-hairline text-[12px] text-text-primary"
            />
          </div>
          <div className="flex flex-col gap-1 flex-1 min-w-[180px]">
            <label className="text-[11px] text-text-tertiary">슬러그</label>
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder="ads-team"
              className="px-3 py-2 rounded-md bg-surface-1 border border-hairline text-[12px] text-text-primary"
            />
          </div>
          <button
            type="button"
            onClick={() => createMut.mutate()}
            disabled={createMut.isPending || !name.trim() || !slug.trim()}
            className="px-4 py-2 rounded-md bg-azure-bright text-[12px] font-semibold text-[#06122b] disabled:opacity-40"
          >
            {createMut.isPending ? "만드는 중…" : "생성"}
          </button>
        </div>
      ) : null}

      {/* 팀 리스트 */}
      <div className="mc-card overflow-hidden">
        {teams.length === 0 ? (
          <div className="p-6 text-center text-text-tertiary text-[12px]">
            소속된 팀이 없습니다. "+ 새 팀" 으로 팀을 만들 수 있습니다.
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="text-[10.5px] font-bold tracking-[0.1em] uppercase text-text-faint">
                <th className="text-left px-5 py-2.5">팀 이름</th>
                <th className="text-left px-5 py-2.5">슬러그</th>
                <th className="text-right px-5 py-2.5">멤버</th>
                <th className="text-right px-5 py-2.5">30일 토큰</th>
                <th className="text-right px-5 py-2.5">30일 비용</th>
              </tr>
            </thead>
            <tbody>
              {teams.map((t) => {
                const agg = aggById.get(t.id);
                return (
                  <tr
                    key={t.id}
                    onClick={() => onSelect(t.id)}
                    className="border-t border-hairline cursor-pointer hover:bg-surface-2/40 transition-colors"
                  >
                    <td className="px-5 py-3 text-[12.5px] text-text-primary font-semibold">
                      {t.name}
                    </td>
                    <td className="px-5 py-3 text-[12px] text-text-tertiary">{t.slug}</td>
                    <td className="px-5 py-3 text-right text-[12px] text-text-primary tabular-nums">
                      {agg ? agg.member_count : "—"}
                    </td>
                    <td className="px-5 py-3 text-right text-[12px] text-text-primary tabular-nums">
                      {agg ? formatTokensCompact(agg.total_tokens) : "—"}
                    </td>
                    <td className="px-5 py-3 text-right text-[12px] text-text-primary tabular-nums">
                      {agg ? formatUSD(agg.total_cost) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// 상세 뷰 — 한 팀의 멤버 + 초대
// =============================================================================
function TeamDetail({ teamId, onBack }: { teamId: string; onBack: () => void }) {
  const qc = useQueryClient();
  const { user } = useAuthUser();
  const [identifier, setIdentifier] = useState("");
  const [error, setError] = useState<string | null>(null);

  const teamsQ = useQuery({
    queryKey: ["my_teams", user?.id ?? "anon"],
    queryFn: fetchMyTeams,
    enabled: !!user,
  });
  const team = useMemo(
    () => teamsQ.data?.find((t) => t.id === teamId) ?? null,
    [teamsQ.data, teamId]
  );

  const membersQ = useQuery({
    queryKey: ["team_members", teamId],
    queryFn: () => fetchTeamMembers(teamId),
    enabled: !!teamId,
  });

  const inviteMut = useMutation({
    mutationFn: () => inviteToTeam(teamId, identifier.trim()),
    onSuccess: () => {
      setIdentifier("");
      setError(null);
      qc.invalidateQueries({ queryKey: ["team_members", teamId] });
      qc.invalidateQueries({ queryKey: ["team_members_usage", teamId] });
      qc.invalidateQueries({ queryKey: ["team_members_usage_lb", teamId] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <div className="flex flex-col gap-5">
      {/* Header — back + 팀 이름 */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="mc-icon-btn"
          aria-label="목록으로"
          title="목록으로"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 12L6 8l4-4" />
          </svg>
        </button>
        <h2 className="text-[18px] font-bold text-text-primary">
          {team?.name ?? "팀"}
        </h2>
        {team ? (
          <span className="text-[11px] text-text-tertiary">/{team.slug}</span>
        ) : null}
      </div>

      {error ? (
        <div className="text-[12px] text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-md px-3 py-2">
          {error}
        </div>
      ) : null}

      {/* 팀 대시보드 — KPI + 멤버 리더보드 + 팀 MCP/플러그인 */}
      <TeamDashboardPanel teamId={teamId} />

      {/* 초대 */}
      <div className="mc-card p-4">
        <div className="text-[11px] font-bold tracking-[0.12em] uppercase text-text-tertiary mb-3">
          멤버 초대
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1 flex-1 min-w-[240px]">
            <label className="text-[11px] text-text-tertiary">
              Slack 핸들 또는 이메일
            </label>
            <input
              type="text"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="@madup-handle 또는 someone@madup.com"
              className="px-3 py-2 rounded-md bg-surface-1 border border-hairline text-[12px] text-text-primary"
            />
          </div>
          <button
            type="button"
            onClick={() => inviteMut.mutate()}
            disabled={inviteMut.isPending || !identifier.trim()}
            className="px-4 py-2 rounded-md bg-azure-bright text-[12px] font-semibold text-[#06122b] disabled:opacity-40"
          >
            {inviteMut.isPending ? "초대 중…" : "초대"}
          </button>
        </div>
      </div>

      {/* 멤버 리스트 */}
      <div className="mc-card">
        <div className="px-5 py-3 border-b border-hairline text-[11px] font-bold tracking-[0.12em] uppercase text-text-tertiary">
          멤버
        </div>
        {membersQ.isLoading ? (
          <div className="p-6 text-center text-text-tertiary text-[12px]">로딩 중…</div>
        ) : (membersQ.data ?? []).length === 0 ? (
          <div className="p-6 text-center text-text-tertiary text-[12px]">
            멤버가 없습니다.
          </div>
        ) : (
          <ul className="flex flex-col">
            {(membersQ.data ?? []).map((m) => {
              const name = m.profile?.name ?? m.profile?.slack_handle ?? m.user_id;
              return (
                <li
                  key={m.user_id}
                  className="flex items-center gap-3 px-5 py-3 border-t border-hairline first:border-t-0"
                >
                  {m.profile?.avatar_url ? (
                    <img
                      src={m.profile.avatar_url}
                      alt={name}
                      className="w-8 h-8 rounded-full object-cover shrink-0"
                    />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-surface-2 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0 leading-tight">
                    <div className="text-[12.5px] font-semibold text-text-primary truncate">
                      {name}
                    </div>
                    <div className="text-[11px] text-text-tertiary truncate mt-0.5">
                      {m.profile?.email ?? "—"}
                    </div>
                  </div>
                  <span className="shrink-0 text-[10px] tracking-[0.1em] uppercase font-bold text-text-tertiary">
                    {m.role}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
