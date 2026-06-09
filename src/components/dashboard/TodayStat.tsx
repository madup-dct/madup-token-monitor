import type { ReactNode } from "react";

interface TodayStatProps {
  label: string;
  value: string;
  sub: ReactNode;
  color: "amber" | "azure" | "violet" | "lime";
}

/// "오늘" feature 카드 하단 stat (라벨 + 큰 숫자 + 보조). 대시보드/유저 상세 공유.
export function TodayStat({ label, value, sub, color }: TodayStatProps) {
  const colorClass = {
    amber: "text-amber",
    azure: "text-azure",
    violet: "text-violet",
    lime: "text-lime",
  }[color];
  return (
    <div>
      <div className="text-[10.5px] font-bold tracking-[0.14em] uppercase text-text-tertiary mb-2 whitespace-nowrap">
        {label}
      </div>
      <div className={`num text-[22px] font-medium leading-tight tracking-[-0.01em] ${colorClass}`}>
        {value}
      </div>
      <div className="text-[11px] text-text-tertiary mt-1">{sub}</div>
    </div>
  );
}
