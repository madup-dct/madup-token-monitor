interface CarouselControlsProps {
  count: number;
  activeIndex: number;
  onIndexChange: (next: number) => void;
  /// 점(dot)의 aria-label/title 용 라벨 (length === count).
  labels: string[];
  auto: boolean;
  onAutoChange: (next: boolean) => void;
}

/// 기간 캐러셀 컨트롤 — 이전/점/다음 + 자동 회전 토글.
/// 사내·내 팀 대시보드의 페이지 헤더에서 공유 (전체 슬라이드 컨트롤).
export function CarouselControls({
  count,
  activeIndex,
  onIndexChange,
  labels,
  auto,
  onAutoChange,
}: CarouselControlsProps) {
  return (
    <div className="flex items-center gap-2 shrink-0">
      <button
        type="button"
        onClick={() => onIndexChange((activeIndex + count - 1) % count)}
        aria-label="이전"
        title="이전"
        className="mc-icon-btn"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 3L5 8l5 5" />
        </svg>
      </button>
      <div className="flex items-center gap-1.5">
        {Array.from({ length: count }).map((_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onIndexChange(i)}
            aria-label={labels[i] ?? String(i + 1)}
            title={labels[i] ?? String(i + 1)}
            className="w-2 h-2 rounded-full transition-colors"
            style={{
              background: i === activeIndex ? "var(--color-azure)" : "var(--color-surface-3)",
            }}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={() => onIndexChange((activeIndex + 1) % count)}
        aria-label="다음"
        title="다음"
        className="mc-icon-btn"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 3l5 5-5 5" />
        </svg>
      </button>
      <button
        type="button"
        role="switch"
        aria-checked={auto}
        onClick={() => onAutoChange(!auto)}
        title="자동 넘기기"
        className="relative w-[34px] h-[20px] rounded-full transition-colors shrink-0 ml-1"
        style={{ background: auto ? "var(--color-azure)" : "var(--color-surface-3)" }}
      >
        <span
          className="absolute top-[2px] left-[2px] w-4 h-4 rounded-full transition-transform"
          style={{
            background: auto ? "#fff" : "var(--color-text-secondary)",
            transform: auto ? "translateX(14px)" : "translateX(0)",
          }}
        />
      </button>
      <span className="text-[11px] text-text-tertiary whitespace-nowrap">자동</span>
    </div>
  );
}
