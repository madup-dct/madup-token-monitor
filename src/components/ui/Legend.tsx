export interface LegendProps {
  swatch: string;
  label: string;
  /// square — 작은 둥근 사각형 (chart bar 등). dot — 작은 원. line — 실선. dashed — 점선.
  shape?: "square" | "dot" | "line" | "dashed";
}

/// 범례 (Legend) 인라인 토큰 — Dashboard / PeriodChartCard 공통.
export function Legend({ swatch, label, shape = "square" }: LegendProps) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {shape === "square" ? (
        <span className="w-2 h-2 rounded-[2px]" style={{ background: swatch }} />
      ) : shape === "dot" ? (
        <span className="rounded-full" style={{ width: 8, height: 8, background: swatch }} />
      ) : shape === "dashed" ? (
        <span
          className="inline-block"
          style={{ width: 14, height: 0, borderTop: `1.5px dashed ${swatch}` }}
        />
      ) : (
        <span
          className="inline-block"
          style={{ width: 14, height: 0, borderTop: `1.5px solid ${swatch}` }}
        />
      )}
      <span>{label}</span>
    </span>
  );
}
