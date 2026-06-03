import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { fetchUsers, searchProfiles, type ProfileLite } from "@/lib/teams";

/// 유저 디렉토리 — 검색 + 권한별 리스트(프로필 사진). 행 클릭 → /user/:id 상세.
/// 가시 범위는 profiles RLS 가 강제 (manager+ = 전사, team_leader = 팀메이트).
export function UserDirectory() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const q = query.trim();

  const listQ = useQuery({
    queryKey: ["user_directory"],
    queryFn: () => fetchUsers(300),
    staleTime: 60_000,
  });
  const searchQ = useQuery({
    queryKey: ["user_search", q],
    queryFn: () => searchProfiles(q, 50),
    enabled: q.length > 0,
    staleTime: 30_000,
  });

  const users: ProfileLite[] = q ? searchQ.data ?? [] : listQ.data ?? [];
  const loading = q ? searchQ.isLoading : listQ.isLoading;

  return (
    <section className="mc-card">
      <header className="mb-3 flex items-baseline justify-between gap-3 flex-wrap">
        <span className="text-[15px] font-semibold text-text-primary">유저 디렉토리</span>
        <span className="text-[11px] text-text-tertiary">프로필 클릭 → 상세 대시보드</span>
      </header>

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="이름 / Slack 핸들 / 이메일 검색"
        className="w-full mb-3 px-3 py-2 rounded-md bg-surface-1 border border-hairline text-[12px] text-text-primary"
      />

      {loading ? (
        <p className="text-[12px] text-text-tertiary py-6 text-center">로딩 중…</p>
      ) : users.length === 0 ? (
        <p className="text-[12px] text-text-tertiary py-6 text-center">
          {q ? "검색 결과 없음" : "표시할 유저가 없습니다"}
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5 max-h-[440px] overflow-y-auto -mx-1 px-1">
          {users.map((u) => {
            const name = u.slack_handle ?? u.name ?? u.email ?? u.id;
            return (
              <li key={u.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/user/${u.id}`)}
                  className="w-full flex items-center gap-3 px-2 py-2 rounded-md text-left hover:bg-surface-2/60 transition-colors"
                >
                  {u.avatar_url ? (
                    <img
                      src={u.avatar_url}
                      alt={name}
                      className="w-8 h-8 rounded-full object-cover shrink-0"
                    />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-surface-2 shrink-0" />
                  )}
                  <div className="min-w-0 leading-tight flex-1">
                    <div className="text-[12.5px] font-semibold text-text-primary truncate">
                      {name}
                    </div>
                    <div className="text-[11px] text-text-tertiary truncate mt-0.5">
                      {u.email ?? "—"}
                    </div>
                  </div>
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-text-faint shrink-0"
                  >
                    <path d="M6 3l5 5-5 5" />
                  </svg>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
