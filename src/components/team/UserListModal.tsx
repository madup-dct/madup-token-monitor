import { useNavigate } from "react-router-dom";
import { Modal } from "@/components/ui/Modal";
import type { EntityUserRow } from "@/hooks/useUsage";

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  valueLabel: string;
  rows: EntityUserRow[];
  formatValue: (v: number) => string;
  isLoading?: boolean;
  error?: Error | null;
}

/// 엔터티(MCP/플러그인/프로젝트) 행 클릭 시 — 그걸 쓴 사용자 + 사용량 리스트.
/// 사용자 클릭 → 해당 유저 상세로 이동.
export function UserListModal({
  open,
  onClose,
  title,
  valueLabel,
  rows,
  formatValue,
  isLoading,
  error,
}: Props) {
  const navigate = useNavigate();
  const max = Math.max(...rows.map((r) => r.value), 1);

  return (
    <Modal open={open} onClose={onClose} title={title} maxWidth={480}>
      <div className="flex items-center justify-between text-[10.5px] font-bold tracking-[0.12em] uppercase text-text-faint px-2 pb-2">
        <span>USER</span>
        <span>{valueLabel}</span>
      </div>
      {error ? (
        <p className="text-[12px] text-coral py-6 text-center">RPC 실패: {String(error.message)}</p>
      ) : isLoading ? (
        <p className="text-[12px] text-text-tertiary py-6 text-center">로딩 중…</p>
      ) : rows.length === 0 ? (
        <p className="text-[12px] text-text-tertiary py-6 text-center">사용 기록 없음</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((r, i) => (
            <li key={r.user_id}>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  navigate(`/user/${r.user_id}`);
                }}
                className="w-full flex items-center gap-3 px-2 py-2 rounded-md hover:bg-surface-2 transition-colors text-left"
              >
                <span className="num w-5 text-right text-[11px] text-text-tertiary shrink-0">
                  {i + 1}
                </span>
                {r.avatar_url ? (
                  <img
                    src={r.avatar_url}
                    alt={r.display_name}
                    className="w-7 h-7 rounded-full object-cover shrink-0"
                  />
                ) : (
                  <div className="w-7 h-7 rounded-full bg-surface-2 shrink-0" />
                )}
                <span className="flex-1 min-w-0 text-[12.5px] text-text-primary font-medium truncate">
                  {r.display_name}
                </span>
                <div className="w-20 h-1.5 rounded-full bg-surface-3 overflow-hidden shrink-0">
                  <div
                    className="h-full bg-azure-bright"
                    style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }}
                  />
                </div>
                <span className="num text-[12px] text-azure font-medium w-16 text-right shrink-0">
                  {formatValue(r.value)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
