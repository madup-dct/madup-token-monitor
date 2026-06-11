interface RankBarListItem {
  label: string;
  value: number;
  /// hover 툴팁 (미지정 시 label). 예: 프로젝트 전체 경로.
  title?: string;
}

type Variant = "azure" | "violet" | "lime" | "amber" | "coral";

interface RankBarListProps {
  items: RankBarListItem[];
  formatValue?: (v: number) => string;
  /// 매 N번째 row 에 강조 색을 순환 배정. mockup 의 azure / violet / lime / amber / coral 톤 사용.
  variants?: Variant[];
  emptyMessage?: string;
  maxRows?: number;
  className?: string;
  /// 지정 시 각 row 가 클릭 가능 (hover 강조). 예: 엔터티 → 사용자 리스트 모달.
  onItemClick?: (item: RankBarListItem, index: number) => void;
}

const FILL: Record<Variant, string> = {
  azure: "linear-gradient(90deg, var(--color-azure-deep), var(--color-azure))",
  violet:
    "linear-gradient(90deg, var(--color-violet-deep), var(--color-violet))",
  lime: "linear-gradient(90deg, var(--color-lime-deep), var(--color-lime))",
  amber: "linear-gradient(90deg, var(--color-amber-deep), var(--color-amber))",
  coral: "linear-gradient(90deg, var(--color-coral-deep), var(--color-coral))",
};
const DEFAULT_VARIANTS: Variant[] = ["azure", "azure", "violet", "azure", "lime", "azure", "amber", "azure"];

/// 랭크 글리프 + 라벨 + mono 값 + 5px gradient 막대. CompanyDashboard 의 MCP/플러그인/모델 분포용.
export function RankBarList({
  items,
  formatValue = (v) => v.toLocaleString("ko-KR"),
  variants = DEFAULT_VARIANTS,
  emptyMessage = "기록 없음",
  maxRows = 8,
  className,
  onItemClick,
}: RankBarListProps) {
  const rows = items.slice(0, maxRows);
  if (rows.length === 0) {
    return (
      <p className="text-[12px] text-text-tertiary py-6 text-center">
        {emptyMessage}
      </p>
    );
  }
  const max = Math.max(...rows.map((r) => r.value), 1);

  return (
    <div className={`flex flex-col gap-3.5 ${className ?? ""}`}>
      {rows.map((it, idx) => {
        const variant: Variant = variants[idx % variants.length];
        const ratio = it.value / max;
        const inner = (
          <>
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <span className="flex items-center gap-2 min-w-0 text-[12px] text-text-primary font-medium">
                <span className="num shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full bg-surface-2 text-text-tertiary text-[10px] font-semibold">
                  {idx + 1}
                </span>
                <span className="truncate" title={it.title ?? it.label}>
                  {it.label}
                </span>
              </span>
              {/* 값 텍스트는 단일 색 — 랭크마다 색이 바뀌면 "값의 크기" 비교를 방해.
                  카테고리 구분은 막대 gradient(variant)가 담당한다. */}
              <span className="num text-[12px] font-medium whitespace-nowrap shrink-0 text-text-primary">
                {formatValue(it.value)}
              </span>
            </div>
            <div className="h-[5px] bg-surface-3 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(2, ratio * 100)}%`,
                  background: FILL[variant],
                }}
              />
            </div>
          </>
        );
        return onItemClick ? (
          <button
            key={`${it.label}-${idx}`}
            type="button"
            onClick={() => onItemClick(it, idx)}
            className="w-full text-left -mx-1 px-1 py-0.5 rounded-md hover:bg-surface-2 transition-colors"
          >
            {inner}
          </button>
        ) : (
          <div key={`${it.label}-${idx}`}>{inner}</div>
        );
      })}
    </div>
  );
}
