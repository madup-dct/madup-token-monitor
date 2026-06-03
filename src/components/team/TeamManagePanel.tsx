import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createTeam,
  fetchMyTeams,
  fetchTeamMembers,
  inviteToTeam,
} from "@/lib/teams";
import { useAuthUser } from "@/hooks/useAuthUser";
import { Select } from "@/components/ui/Select";
import type { Team } from "@/types/models";

/// 팀 생성 + 멤버 초대 + 멤버 표시.
/// team_leader+ 일 때 노출. owner/admin 만 실제로 초대 가능 (RPC 가드).
export function TeamManagePanel() {
  const qc = useQueryClient();
  const { user, myTeamIds } = useAuthUser();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [identifier, setIdentifier] = useState("");
  const [error, setError] = useState<string | null>(null);

  const teamsQ = useQuery({
    queryKey: ["my_teams", user?.id ?? "anon"],
    queryFn: fetchMyTeams,
    enabled: !!user,
  });

  const teams: Team[] = (teamsQ.data ?? []).filter((t) => myTeamIds.includes(t.id));

  const membersQ = useQuery({
    queryKey: ["team_members", selectedTeamId],
    queryFn: () => fetchTeamMembers(selectedTeamId!),
    enabled: !!selectedTeamId,
  });

  const createMut = useMutation({
    mutationFn: () => createTeam(name.trim(), slug.trim()),
    onSuccess: (t) => {
      setName("");
      setSlug("");
      setError(null);
      qc.invalidateQueries({ queryKey: ["my_teams"] });
      setSelectedTeamId(t.id);
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  const inviteMut = useMutation({
    mutationFn: () => {
      if (!selectedTeamId) throw new Error("팀을 먼저 선택하세요");
      return inviteToTeam(selectedTeamId, identifier.trim());
    },
    onSuccess: () => {
      setIdentifier("");
      setError(null);
      qc.invalidateQueries({ queryKey: ["team_members", selectedTeamId] });
      qc.invalidateQueries({ queryKey: ["team_members_usage", selectedTeamId] });
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  if (!user) return null;

  return (
    <div className="flex flex-col gap-5">
      {error ? (
        <div className="text-[12px] text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-md px-3 py-2">
          {error}
        </div>
      ) : null}

      {/* 팀 생성 */}
      <div className="mc-card p-5">
        <div className="text-[11px] font-bold tracking-[0.12em] uppercase text-text-tertiary mb-3">
          새 팀 만들기
        </div>
        <div className="flex flex-wrap items-end gap-3">
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
            <label className="text-[11px] text-text-tertiary">슬러그 (영문/숫자/하이픈)</label>
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
            {createMut.isPending ? "만드는 중…" : "팀 생성"}
          </button>
        </div>
      </div>

      {/* 팀 선택 + 멤버 + 초대 */}
      <div className="mc-card p-5 flex flex-col gap-4">
        <div className="text-[11px] font-bold tracking-[0.12em] uppercase text-text-tertiary">
          팀 멤버 관리
        </div>
        {teams.length === 0 ? (
          <div className="text-[12px] text-text-tertiary">먼저 팀을 만들어 주세요.</div>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-text-tertiary">팀</span>
              <Select
                value={selectedTeamId ?? ""}
                onChange={(v) => setSelectedTeamId(v || null)}
                options={[
                  { value: "", label: "팀 선택…" },
                  ...teams.map((t) => ({ value: t.id, label: t.name })),
                ]}
                ariaLabel="팀 선택"
              />
            </div>

            {selectedTeamId ? (
              <>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex flex-col gap-1 flex-1 min-w-[220px]">
                    <label className="text-[11px] text-text-tertiary">
                      초대 — Slack 핸들 또는 이메일
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

                <div>
                  <div className="text-[11px] text-text-tertiary mb-2">현재 멤버</div>
                  {membersQ.isLoading ? (
                    <div className="text-[12px] text-text-tertiary">로딩 중…</div>
                  ) : (membersQ.data ?? []).length === 0 ? (
                    <div className="text-[12px] text-text-tertiary">멤버 없음</div>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {(membersQ.data ?? []).map((m) => {
                        const name =
                          m.profile?.name ?? m.profile?.slack_handle ?? m.user_id;
                        return (
                          <li
                            key={m.user_id}
                            className="flex items-center gap-3 px-3 py-2 rounded-md bg-surface-1 border border-hairline"
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
                            <div className="flex-1 min-w-0 leading-tight">
                              <div className="text-[12px] font-semibold text-text-primary truncate">
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
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
