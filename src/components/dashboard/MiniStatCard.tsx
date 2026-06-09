import type { ReactNode } from "react";

interface MiniStatProps {
  eyebrow: string;
  value: string;
  suffix: string;
  subline: ReactNode;
  foot: { label: string; value: string }[];
  /// grid-cols-12 안에서 차지할 span (default 3).
  colSpan?: number;
}

const SPAN_CLASS: Record<number, string> = {
  3: "col-span-3",
  4: "col-span-4",
  6: "col-span-6",
};

/// 큰 숫자 + suffix + subline + foot(비용/입력 등) 미니 통계 카드. 대시보드/유저 상세 공유.
export function MiniStatCard({ eyebrow, value, suffix, subline, foot, colSpan = 3 }: MiniStatProps) {
  return (
    <section className={`mc-card ${SPAN_CLASS[colSpan] ?? "col-span-3"}`}>
      <header className="mb-1">
        <span className="mc-eyebrow">{eyebrow}</span>
      </header>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="num text-[36px] font-medium leading-none tracking-[-0.02em] text-azure">
          {value}
        </span>
        <span className="text-[12px] text-text-secondary">{suffix}</span>
      </div>
      <div className="text-[11px] text-text-tertiary mt-1.5">{subline}</div>
      <div className="mt-3.5 pt-3 border-t border-hairline flex gap-3.5 text-[11px] text-text-tertiary">
        {foot.map((f) => (
          <span key={f.label}>
            <strong className="num text-text-secondary font-semibold mr-1">{f.value}</strong>
            {f.label}
          </span>
        ))}
      </div>
    </section>
  );
}
