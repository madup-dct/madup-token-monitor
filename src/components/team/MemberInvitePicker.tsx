import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { searchProfilesForInvite, type InviteCandidate } from "@/lib/teams";
import { DropdownPortal } from "@/components/ui/DropdownPortal";

interface MemberInvitePickerProps {
  teamId: string;
  onInvite: (userIds: string[]) => void;
  isInviting?: boolean;
}

/// 멤버 초대 자동완성 다중선택.
/// 입력 debounce(250ms) → searchProfilesForInvite → 드롭다운(이름 + 이메일/handle) →
/// 클릭 시 선택칩 누적(중복 방지) → "N명 초대" 버튼 → onInvite(selectedIds).
/// 외부클릭/Escape 로 드롭다운 닫힘.
export function MemberInvitePicker({ teamId, onInvite, isInviting = false }: MemberInvitePickerProps) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<InviteCandidate[]>([]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 입력 debounce (~250ms).
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  // 외부클릭 / Escape 닫힘.
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      const t = e.target as Node;
      // portal 로 띄운 메뉴(menuRef)도 "내부"로 취급 — 옵션 클릭 시 닫히지 않게.
      if (!wrapRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const searchQ = useQuery({
    queryKey: ["invite_candidates", teamId, debounced],
    queryFn: () => searchProfilesForInvite(teamId, debounced, 10),
    enabled: !!teamId && debounced.length >= 2,
    staleTime: 30_000,
  });

  const selectedIds = new Set(selected.map((s) => s.user_id));
  const results = (searchQ.data ?? []).filter((c) => !selectedIds.has(c.user_id));

  function addCandidate(c: InviteCandidate) {
    if (selectedIds.has(c.user_id)) return;
    setSelected((prev) => [...prev, c]);
    setQuery("");
    setDebounced("");
  }

  function removeCandidate(userId: string) {
    setSelected((prev) => prev.filter((s) => s.user_id !== userId));
  }

  function handleInvite() {
    if (selected.length === 0) return;
    onInvite(selected.map((s) => s.user_id));
    setSelected([]);
    setQuery("");
    setDebounced("");
    setOpen(false);
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 선택칩 */}
      {selected.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {selected.map((s) => {
            const label = s.name ?? s.slack_handle ?? s.email ?? s.user_id;
            return (
              <span
                key={s.user_id}
                className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-md bg-azure-soft text-azure-bright text-[11.5px] font-medium"
              >
                {label}
                <button
                  type="button"
                  onClick={() => removeCandidate(s.user_id)}
                  aria-label={`${label} 제거`}
                  className="shrink-0 rounded hover:bg-azure-bright/20 p-0.5 transition-colors"
                >
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <path d="M3 3l6 6M9 3l-6 6" />
                  </svg>
                </button>
              </span>
            );
          })}
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        {/* 검색 입력 + 드롭다운 */}
        <div ref={wrapRef} className="relative flex flex-col gap-1 flex-1 min-w-[240px]">
          <label className="text-[11px] text-text-tertiary">이름 / 이메일</label>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            placeholder="이름 / 이메일"
            className="px-3 py-2 rounded-md bg-surface-1 border border-hairline text-[12px] text-text-primary"
          />

          <DropdownPortal
            anchorRef={inputRef}
            open={open && debounced.length >= 2}
            menuRef={menuRef}
            role="listbox"
            className="rounded-md border border-hairline overflow-hidden"
            style={{
              background: "var(--color-surface-2)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            }}
          >
              {searchQ.isLoading ? (
                <div className="px-3 py-2.5 text-[12px] text-text-tertiary">검색 중…</div>
              ) : results.length === 0 ? (
                <div className="px-3 py-2.5 text-[12px] text-text-tertiary">검색 결과 없음</div>
              ) : (
                <ul className="max-h-[280px] overflow-y-auto">
                  {results.map((c) => {
                    const name = c.name ?? c.slack_handle ?? c.email ?? c.user_id;
                    const sub = c.email ?? c.slack_handle ?? "—";
                    return (
                      <li key={c.user_id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={false}
                          onClick={() => addCandidate(c)}
                          className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-surface-3 transition-colors"
                        >
                          {c.avatar_url ? (
                            <img
                              src={c.avatar_url}
                              alt={name}
                              className="w-7 h-7 rounded-full object-cover shrink-0"
                            />
                          ) : (
                            <div className="w-7 h-7 rounded-full bg-surface-2 shrink-0" />
                          )}
                          <div className="min-w-0 leading-tight flex-1">
                            <div className="text-[12.5px] font-semibold text-text-primary truncate">
                              {name}
                            </div>
                            <div className="text-[11px] text-text-tertiary truncate mt-0.5">
                              {sub}
                            </div>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
          </DropdownPortal>
        </div>

        {/* 초대 버튼 */}
        <button
          type="button"
          onClick={handleInvite}
          disabled={isInviting || selected.length === 0}
          className="px-4 py-2 rounded-md bg-azure-bright text-[12px] font-semibold text-[#06122b] disabled:opacity-40"
        >
          {isInviting ? "초대 중…" : `${selected.length}명 초대`}
        </button>
      </div>
    </div>
  );
}
