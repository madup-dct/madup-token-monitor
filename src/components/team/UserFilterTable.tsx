import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Select } from "@/components/ui/Select";
import { SearchInput } from "@/components/ui/SearchInput";
import { formatTokensCompact, formatUSD } from "@/lib/format";
import type { DirectoryRow } from "@/hooks/useUsage";

type SortKey = "name" | "tokens" | "cost";

const ROLE_OPTIONS = [
  { value: "", label: "전체 권한" },
  { value: "user", label: "user" },
  { value: "team_leader", label: "team_leader" },
  { value: "manager", label: "manager" },
  { value: "admin", label: "admin" },
];

const ROLE_LABEL: Record<string, string> = {
  user: "user",
  team_leader: "리더",
  manager: "매니저",
  admin: "어드민",
};

/// 전사 유저 테이블 — 권한·팀·토큰·이름·이메일. 정렬 + 권한/팀 필터 + 이름/이메일 검색.
export function UserFilterTable({
  rows,
  isLoading,
  error,
}: {
  rows: DirectoryRow[];
  isLoading?: boolean;
  error?: Error | null;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [teamFilter, setTeamFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("tokens");
  const [asc, setAsc] = useState(false);

  const teamOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows)
      for (const t of (r.teams ?? "").split(",").map((s) => s.trim()).filter(Boolean)) set.add(t);
    return [{ value: "", label: "전체 팀" }, ...[...set].sort().map((t) => ({ value: t, label: t }))];
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = rows.filter((r) => {
      if (roleFilter && r.role !== roleFilter) return false;
      if (
        teamFilter &&
        !(r.teams ?? "").split(",").map((s) => s.trim()).includes(teamFilter)
      )
        return false;
      if (
        q &&
        !(
          r.display_name.toLowerCase().includes(q) ||
          (r.email ?? "").toLowerCase().includes(q)
        )
      )
        return false;
      return true;
    });
    out.sort((a, b) => {
      let d = 0;
      if (sortKey === "name") d = a.display_name.localeCompare(b.display_name);
      else if (sortKey === "cost") d = a.total_cost - b.total_cost;
      else d = a.total_tokens - b.total_tokens;
      return asc ? d : -d;
    });
    return out;
  }, [rows, query, roleFilter, teamFilter, sortKey, asc]);

  function toggleSort(k: SortKey) {
    if (sortKey === k) setAsc((v) => !v);
    else {
      setSortKey(k);
      setAsc(k === "name");
    }
  }

  const arrow = (k: SortKey) => (sortKey === k ? (asc ? " ▲" : " ▼") : "");

  return (
    <section className="mc-card">
      {/* Filter bar */}
      <div className="flex items-center gap-2 flex-wrap pb-3 mb-1 border-b border-hairline">
        <span className="text-[15px] font-semibold text-text-primary mr-1">전사 유저</span>
        <Select value={roleFilter} onChange={setRoleFilter} options={ROLE_OPTIONS} ariaLabel="권한 필터" />
        <Select value={teamFilter} onChange={setTeamFilter} options={teamOptions} ariaLabel="팀 필터" />
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="이름 / 이메일 검색…"
          className="ml-auto flex-[0_1_240px]"
        />
      </div>

      {error ? (
        <p className="text-[12px] text-coral py-6 text-center">RPC 실패: {String(error.message)}</p>
      ) : isLoading ? (
        <p className="text-[12px] text-text-tertiary py-8 text-center">불러오는 중…</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-[10.5px] font-bold tracking-[0.1em] uppercase text-text-faint">
                <th className="text-left px-3 py-2.5">
                  <button type="button" onClick={() => toggleSort("name")} className="hover:text-text-secondary">
                    이름{arrow("name")}
                  </button>
                </th>
                <th className="text-left px-3 py-2.5">이메일</th>
                <th className="text-left px-3 py-2.5">권한</th>
                <th className="text-left px-3 py-2.5">팀</th>
                <th className="text-right px-3 py-2.5">
                  <button type="button" onClick={() => toggleSort("tokens")} className="hover:text-text-secondary">
                    토큰{arrow("tokens")}
                  </button>
                </th>
                <th className="text-right px-3 py-2.5">
                  <button type="button" onClick={() => toggleSort("cost")} className="hover:text-text-secondary">
                    비용{arrow("cost")}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-text-tertiary text-[12px]">
                    조건에 맞는 사용자가 없습니다.
                  </td>
                </tr>
              ) : (
                filtered.map((r) => (
                  <tr
                    key={r.user_id}
                    onClick={() => navigate(`/user/${r.user_id}`)}
                    className="border-t border-hairline cursor-pointer hover:bg-surface-2/40 transition-colors"
                  >
                    <td className="px-3 py-2.5 text-[12.5px] text-text-primary font-medium whitespace-nowrap">
                      {r.display_name}
                    </td>
                    <td className="px-3 py-2.5 text-[12px] text-text-tertiary whitespace-nowrap">
                      {r.email ?? "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="text-[10.5px] font-bold tracking-[0.06em] uppercase rounded px-1.5 py-0.5 bg-azure-soft text-azure-bright">
                        {ROLE_LABEL[r.role] ?? r.role}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-[12px] text-text-secondary whitespace-nowrap">
                      {r.teams ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right text-[12px] text-azure tabular-nums whitespace-nowrap">
                      {formatTokensCompact(r.total_tokens)}
                    </td>
                    <td className="px-3 py-2.5 text-right text-[12px] text-amber tabular-nums whitespace-nowrap">
                      {formatUSD(r.total_cost)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-2 pt-2.5 border-t border-hairline text-[11px] text-text-tertiary">
        {filtered.length}명 · 행 클릭 시 상세
      </div>
    </section>
  );
}
