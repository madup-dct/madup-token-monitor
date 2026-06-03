import type { ReactNode } from "react";

export interface KpiHeroProps {
  eyebrow: string;
  value: string;
  suffix?: string;
  color: "azure" | "amber" | "lime" | "violet";
  context?: ReactNode;
  spark?: ReactNode;
  rightAccessory?: ReactNode;
  colSpan?: number; // grid-cols-12 안에서 차지할 span (default 3)
}

const COLOR_CLASS: Record<KpiHeroProps["color"], string> = {
  azure: "text-azure",
  amber: "text-amber",
  lime: "text-lime",
  violet: "text-violet",
};

const SPAN_CLASS: Record<number, string> = {
  3: "col-span-3",
  4: "col-span-4",
  6: "col-span-6",
};

/// 대시보드 공통 KPI 카드 — Dashboard / UserDashboard 동일 시각.
export function KpiHero({
  eyebrow,
  value,
  suffix,
  color,
  context,
  spark,
  rightAccessory,
  colSpan = 3,
}: KpiHeroProps) {
  return (
    <section className={`mc-card relative ${SPAN_CLASS[colSpan] ?? "col-span-3"}`}>
      <div className="text-[10.5px] font-bold tracking-[0.16em] uppercase text-text-tertiary whitespace-nowrap">
        {eyebrow}
      </div>
      <div className="mt-3.5 flex items-baseline gap-2">
        <span
          className={`num text-[40px] font-medium leading-none tracking-[-0.02em] ${COLOR_CLASS[color]}`}
        >
          {value}
        </span>
        {suffix ? (
          <span className="text-[12px] text-text-secondary">{suffix}</span>
        ) : null}
      </div>
      {context ? (
        <div className="mt-2.5 flex items-center gap-1.5 flex-wrap text-[11.5px] text-text-secondary">
          {context}
        </div>
      ) : null}
      {spark ? (
        <div className="absolute right-4 bottom-3 opacity-85 pointer-events-none">
          {spark}
        </div>
      ) : null}
      {rightAccessory ? (
        <div className="absolute right-4 bottom-3 pointer-events-none">
          {rightAccessory}
        </div>
      ) : null}
    </section>
  );
}
