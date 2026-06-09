/// 활성 카운트 dot grid — KPI hero 의 rightAccessory 로 사용.
/// count 만큼 lime 점, 나머지는 surface-3. (사내/내 팀 대시보드 공유)
export function DotGrid({ count, max }: { count: number; max: number }) {
  const cells = Array.from({ length: max });
  return (
    <div
      className="grid gap-[5px]"
      style={{ gridTemplateColumns: "repeat(8, 8px)" }}
    >
      {cells.map((_, i) => (
        <span
          key={i}
          className="w-2 h-2 rounded-[2px]"
          style={{
            background:
              i < count ? "var(--color-lime)" : "var(--color-surface-3)",
            boxShadow:
              i < count ? "0 0 6px rgba(155,225,93,0.5)" : undefined,
          }}
        />
      ))}
    </div>
  );
}
