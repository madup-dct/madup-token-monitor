import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  createTeam,
  deleteTeam,
  fetchMyMemberships,
  fetchMyTeams,
  fetchTeamAggregates,
  fetchTeamMemberRoles,
  fetchTeamMembers,
  inviteMembersToTeam,
  removeTeamMember,
  transferTeamOwner,
} from "@/lib/teams";
import { useAuthUser } from "@/hooks/useAuthUser";
import { formatTokensCompact, formatUSD } from "@/lib/format";
import { TeamDashboardPanel } from "@/components/team/TeamDashboardPanel";
import { MemberInvitePicker } from "@/components/team/MemberInvitePicker";
import type { AppRole, Team, TeamMemberWithProfile } from "@/types/models";

const TEAM_ROLE_RANK: Record<TeamMemberWithProfile["role"], number> = {
  owner: 0,
  admin: 1,
  member: 2,
};

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
  const membershipsQ = useQuery({
    queryKey: ["my_memberships", user?.id ?? "anon"],
    queryFn: fetchMyMemberships,
    enabled: !!user,
  });
  const ownedTeamIds = useMemo(
    () => new Set((membershipsQ.data ?? []).filter((m) => m.role === "owner").map((m) => m.team_id)),
    [membershipsQ.data],
  );
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
                      <span className="inline-flex items-center gap-1.5">
                        {t.name}
                        {ownedTeamIds.has(t.id) ? (
                          <span className="px-1.5 py-0.5 rounded bg-azure-bright/15 text-azure text-[9.5px] font-bold tracking-[0.06em] uppercase">
                            팀장
                          </span>
                        ) : null}
                      </span>
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
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

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
  // 현재 사용자의 이 팀 내 역할 — owner/admin 만 강퇴 가능(RLS 도 동일하게 강제).
  const myTeamRole = useMemo(
    () => membersQ.data?.find((m) => m.user_id === user?.id)?.role ?? null,
    [membersQ.data, user?.id]
  );
  const canManage = myTeamRole === "owner" || myTeamRole === "admin";
  const isOwner = myTeamRole === "owner";
  const memberRolesQ = useQuery({
    queryKey: ["team_member_roles", teamId],
    queryFn: () => fetchTeamMemberRoles(teamId),
    enabled: !!teamId && isOwner,
  });
  const memberRoles: Record<string, AppRole> = memberRolesQ.data ?? {};
  const [transferId, setTransferId] = useState<string | null>(null);

  const transferMut = useMutation({
    mutationFn: (userId: string) => transferTeamOwner(teamId, userId),
    onSuccess: () => {
      setTransferId(null);
      setError(null);
      setNotice("팀장을 이전했습니다");
      qc.invalidateQueries({ queryKey: ["team_members", teamId] });
      qc.invalidateQueries({ queryKey: ["team_member_roles", teamId] });
      qc.invalidateQueries({ queryKey: ["my_memberships"] });
      qc.invalidateQueries({ queryKey: ["my_teams"] });
    },
    onError: (e) => {
      setNotice(null);
      setError(e instanceof Error ? e.message : String(e));
    },
  });

  const memberCount = (membersQ.data ?? []).length;
  const canDelete = isOwner && memberCount <= 1;
  const [confirmDelete, setConfirmDelete] = useState(false);

  const deleteMut = useMutation({
    mutationFn: () => deleteTeam(teamId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["my_teams"] });
      qc.invalidateQueries({ queryKey: ["my_memberships"] });
      qc.invalidateQueries({ queryKey: ["team_aggregates"] });
      onBack();
    },
    onError: (e) => {
      setConfirmDelete(false);
      setNotice(null);
      setError(e instanceof Error ? e.message : String(e));
    },
  });

  const inviteMut = useMutation({
    mutationFn: (userIds: string[]) => inviteMembersToTeam(teamId, userIds),
    onSuccess: (added: number) => {
      setError(null);
      setNotice(added > 0 ? `${added}명 초대했습니다` : "선택한 사용자는 이미 모두 멤버입니다");
      qc.invalidateQueries({ queryKey: ["team_members", teamId] });
      qc.invalidateQueries({ queryKey: ["team_members_usage", teamId] });
      qc.invalidateQueries({ queryKey: ["team_members_usage_lb", teamId] });
      qc.invalidateQueries({ queryKey: ["invite_candidates", teamId] });
    },
    onError: (e) => {
      setNotice(null);
      setError(e instanceof Error ? e.message : String(e));
    },
  });

  const removeMut = useMutation({
    mutationFn: (userId: string) => removeTeamMember(teamId, userId),
    onSuccess: () => {
      setConfirmingId(null);
      setError(null);
      setNotice("멤버를 제거했습니다");
      qc.invalidateQueries({ queryKey: ["team_members", teamId] });
      qc.invalidateQueries({ queryKey: ["team_members_usage", teamId] });
      qc.invalidateQueries({ queryKey: ["team_members_usage_lb", teamId] });
    },
    onError: (e) => {
      setNotice(null);
      setError(e instanceof Error ? e.message : String(e));
    },
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

      {/* 초대 — 자동완성 다중선택 (상단) */}
      <div className="mc-card p-4">
        <div className="text-[11px] font-bold tracking-[0.12em] uppercase text-text-tertiary mb-3">
          멤버 초대
        </div>
        <MemberInvitePicker
          teamId={teamId}
          onInvite={(userIds) => inviteMut.mutate(userIds)}
          isInviting={inviteMut.isPending}
        />
      </div>

      {error ? (
        <div className="text-[12px] text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-md px-3 py-2">
          {error}
        </div>
      ) : notice ? (
        <div className="text-[12px] text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded-md px-3 py-2">
          {notice}
        </div>
      ) : null}

      {/* 멤버 관리 — 강퇴 (팀 owner/admin 전용). RLS 가 서버에서도 권한 강제. */}
      {canManage ? (
        <div className="mc-card p-4">
          <div className="text-[11px] font-bold tracking-[0.12em] uppercase text-text-tertiary mb-3">
            멤버 관리
          </div>
          {membersQ.isLoading ? (
            <div className="text-[12px] text-text-tertiary px-1">불러오는 중…</div>
          ) : (membersQ.data ?? []).length === 0 ? (
            <div className="text-[12px] text-text-tertiary px-1">멤버 없음</div>
          ) : (
            <ul className="flex flex-col">
              {(membersQ.data ?? [])
                .slice()
                .sort((a, b) => TEAM_ROLE_RANK[a.role] - TEAM_ROLE_RANK[b.role])
                .map((m) => {
                  const name =
                    m.profile?.name ??
                    m.profile?.slack_handle ??
                    m.profile?.email ??
                    m.user_id;
                  const removable = m.role !== "owner" && m.user_id !== user?.id;
                  const transferable =
                    isOwner &&
                    m.role !== "owner" &&
                    m.user_id !== user?.id &&
                    ["team_leader", "manager", "admin"].includes(memberRoles[m.user_id] ?? "user");
                  return (
                    <li
                      key={m.user_id}
                      className="flex items-center gap-3 py-2.5 border-b border-hairline last:border-b-0"
                    >
                      {m.profile?.avatar_url ? (
                        <img
                          src={m.profile.avatar_url}
                          alt={name}
                          className="w-7 h-7 rounded-full object-cover shrink-0"
                        />
                      ) : (
                        <div className="w-7 h-7 rounded-full bg-surface-2 shrink-0" />
                      )}
                      <div className="min-w-0 flex-1 leading-tight">
                        <div className="text-[12.5px] font-semibold text-text-primary truncate">
                          {name}
                        </div>
                        <div className="text-[11px] text-text-tertiary truncate mt-0.5">
                          {m.profile?.email ?? "—"}
                        </div>
                      </div>
                      <span className="text-[10px] font-bold uppercase tracking-[0.06em] text-text-tertiary shrink-0">
                        {m.role}
                      </span>
                      {transferable ? (
                        transferId === m.user_id ? (
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              disabled={transferMut.isPending}
                              onClick={() => transferMut.mutate(m.user_id)}
                              className="px-2.5 py-1 rounded-md bg-azure-bright/15 text-azure text-[11px] font-semibold disabled:opacity-50"
                            >
                              팀장 위임
                            </button>
                            <button
                              type="button"
                              onClick={() => setTransferId(null)}
                              className="px-2.5 py-1 rounded-md bg-surface-2 text-text-secondary text-[11px] font-semibold"
                            >
                              취소
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setTransferId(m.user_id)}
                            title="이 멤버를 팀장으로 위임"
                            className="px-2 py-1 rounded-md text-[11px] font-semibold text-text-tertiary hover:text-azure shrink-0"
                          >
                            팀장 위임
                          </button>
                        )
                      ) : null}
                      {removable ? (
                        confirmingId === m.user_id ? (
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              disabled={removeMut.isPending}
                              onClick={() => removeMut.mutate(m.user_id)}
                              className="px-2.5 py-1 rounded-md bg-rose-500/15 text-rose-300 text-[11px] font-semibold disabled:opacity-50"
                            >
                              제거
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmingId(null)}
                              className="px-2.5 py-1 rounded-md bg-surface-2 text-text-secondary text-[11px] font-semibold"
                            >
                              취소
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmingId(m.user_id)}
                            aria-label={`${name} 제거`}
                            title="팀에서 제거"
                            className="mc-icon-btn shrink-0 text-text-tertiary hover:text-rose-300"
                          >
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                              <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
                            </svg>
                          </button>
                        )
                      ) : (
                        <span className="w-7 shrink-0" />
                      )}
                    </li>
                  );
                })}
            </ul>
          )}
        </div>
      ) : null}

      {/* 팀 삭제 — owner 전용 danger zone. 팀원이 남아 있으면 경고 + 비활성. */}
      {isOwner ? (
        <div className="mc-card p-4 border border-rose-500/20">
          <div className="text-[11px] font-bold tracking-[0.12em] uppercase text-rose-300/80 mb-2">
            위험 구역
          </div>
          {memberCount > 1 ? (
            <p className="text-[12px] text-text-tertiary mb-3">
              팀원 {memberCount - 1}명을 모두 내보낸 뒤에 팀을 삭제할 수 있습니다.
            </p>
          ) : (
            <p className="text-[12px] text-text-tertiary mb-3">
              이 팀을 삭제하면 되돌릴 수 없습니다.
            </p>
          )}
          {confirmDelete && canDelete ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={deleteMut.isPending}
                onClick={() => deleteMut.mutate()}
                className="px-3 py-1.5 rounded-md bg-rose-500/20 text-rose-200 text-[12px] font-semibold disabled:opacity-50"
              >
                {deleteMut.isPending ? "삭제 중…" : "정말 삭제"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="px-3 py-1.5 rounded-md bg-surface-2 text-text-secondary text-[12px] font-semibold"
              >
                취소
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={!canDelete}
              onClick={() => setConfirmDelete(true)}
              className="px-3 py-1.5 rounded-md bg-rose-500/15 text-rose-300 text-[12px] font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
            >
              팀 삭제
            </button>
          )}
        </div>
      ) : null}

      {/* 팀 대시보드 — KPI + 멤버 리더보드 + 팀 MCP/플러그인 */}
      <TeamDashboardPanel teamId={teamId} />
    </div>
  );
}
