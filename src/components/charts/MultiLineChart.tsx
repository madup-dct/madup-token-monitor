import { useMemo, useRef, useState } from "react";
import { niceTickStep } from "./DailyBarChart";
import { tickY } from "@/lib/usage-math";

export interface LineSeries {
  label: string;
  /// CSS color (var(--color-*) 또는 hex)
  color: string;
  points: number[];
}

interface Props {
  series: LineSeries[];
  xLabels: string[];
  formatValue: (n: number) => string;
  height?: number;
}

const CHART_W = 720;
const Y_AXIS_W = 50;
const PAD_TOP = 16;
const PAD_BOT = 28;

/// 여러 시리즈(평균/최대/최소)를 같은 시간축에 그리는 라인차트.
/// - 범례 클릭으로 시리즈 on/off (y축 자동 리스케일)
/// - 영역 그라데이션 + hover 크로스헤어/툴팁/끝점 dot
export function MultiLineChart({ series, xLabels, formatValue, height = 280 }: Props) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const n = xLabels.length;
  const visible = series.filter((s) => !hidden.has(s.label));
  // 시리즈별 고정 gradient id (label 이 한글이라 index 기반).
  const idOf = useMemo(() => {
    const m = new Map<string, string>();
    series.forEach((s, i) => m.set(s.label, `mlc-grad-${i}`));
    return m;
  }, [series]);

  const { maxVal, ticks } = useMemo(() => {
    const all = visible.flatMap((s) => s.points);
    const max = Math.max(...all, 1);
    const tick = niceTickStep(max / 4);
    const top = Math.ceil(max / tick) * tick;
    return { maxVal: top, ticks: [top, top * 0.75, top * 0.5, top * 0.25] };
  }, [visible]);

  const innerW = CHART_W - Y_AXIS_W;
  const innerH = height - PAD_TOP - PAD_BOT;
  const colW = innerW / Math.max(n - 1, 1);
  const xOf = (i: number) => Y_AXIS_W + i * colW;
  const yOf = (v: number) => PAD_TOP + innerH - (v / maxVal) * innerH;
  const labelStep = Math.max(1, Math.ceil(36 / Math.max(colW, 1)));

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const el = svgRef.current;
    if (!el || n === 0) return;
    // getScreenCTM 으로 client → viewBox 좌표 정확 변환 (preserveAspectRatio 무관).
    const pt = el.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = el.getScreenCTM();
    if (!ctm) return;
    const u = pt.matrixTransform(ctm.inverse());
    let i = Math.round((u.x - Y_AXIS_W) / colW);
    i = Math.max(0, Math.min(n - 1, i));
    setHover(i);
  }

  function toggle(label: string) {
    setHidden((prev) => {
      const s = new Set(prev);
      if (s.has(label)) s.delete(label);
      else s.add(label);
      return s;
    });
  }

  if (n === 0) {
    return (
      <div className="grid place-items-center text-text-tertiary text-[12px]" style={{ height }}>
        기록 없음
      </div>
    );
  }

  // 툴팁 박스 위치 (오른쪽 끝 넘치면 왼쪽으로 flip)
  const tipW = 132;
  const tipH = 16 + visible.length * 15;
  const tipX =
    hover != null && xOf(hover) + 12 + tipW > CHART_W ? xOf(hover) - 12 - tipW : (hover != null ? xOf(hover) + 12 : 0);
  const tipY = PAD_TOP + 2;

  return (
    <div>
      <svg
        ref={svgRef}
        width="100%"
        height={height}
        viewBox={`0 0 ${CHART_W} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ display: "block" }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          {series.map((s) => (
            <linearGradient key={s.label} id={idOf.get(s.label)} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity="0.16" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>

        {/* gridlines */}
        <g stroke="rgba(255,255,255,0.05)" strokeWidth={1}>
          {ticks.map((t, i) => {
            const y = tickY(t, maxVal, PAD_TOP, innerH);
            return <line key={i} x1={Y_AXIS_W} y1={y} x2={CHART_W} y2={y} />;
          })}
        </g>
        {/* y-axis labels */}
        <g fill="#454E6A" fontSize="10" fontFamily="JetBrains Mono, monospace">
          {ticks.map((t, i) => {
            const y = tickY(t, maxVal, PAD_TOP, innerH);
            return (
              <text key={i} x={Y_AXIS_W - 6} y={y + 3} textAnchor="end">
                {formatValue(t)}
              </text>
            );
          })}
        </g>

        {/* area + line per visible series */}
        {visible.map((s) => {
          const line = s.points
            .map((v, i) => (i === 0 ? `M ${xOf(i)} ${yOf(v)}` : `L ${xOf(i)} ${yOf(v)}`))
            .join(" ");
          const area = `${line} L ${xOf(n - 1)} ${PAD_TOP + innerH} L ${xOf(0)} ${PAD_TOP + innerH} Z`;
          return (
            <g key={s.label}>
              <path d={area} fill={`url(#${idOf.get(s.label)})`} />
              <path
                d={line}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </g>
          );
        })}

        {/* x-axis labels (thinned) */}
        <g fill="#6A7593" fontSize="10.5" fontFamily="JetBrains Mono, monospace">
          {xLabels.map((lab, i) =>
            i % labelStep === 0 || i === n - 1 ? (
              <text key={i} x={xOf(i)} y={height - 8} textAnchor="middle">
                {lab}
              </text>
            ) : null,
          )}
        </g>

        {/* hover crosshair + dots + tooltip */}
        {hover != null && visible.length > 0 && (
          <g>
            <line
              x1={xOf(hover)}
              y1={PAD_TOP}
              x2={xOf(hover)}
              y2={PAD_TOP + innerH}
              stroke="rgba(255,255,255,0.18)"
              strokeWidth={1}
            />
            {visible.map((s) => (
              <circle
                key={s.label}
                cx={xOf(hover)}
                cy={yOf(s.points[hover] ?? 0)}
                r={3.5}
                fill={s.color}
                stroke="#0b1020"
                strokeWidth={1.5}
              />
            ))}
            <rect
              x={tipX}
              y={tipY}
              width={tipW}
              height={tipH}
              rx={6}
              fill="rgba(11,16,32,0.95)"
              stroke="rgba(255,255,255,0.12)"
            />
            <text
              x={tipX + 8}
              y={tipY + 13}
              fontSize="9.5"
              fill="#9aa5c0"
              fontFamily="JetBrains Mono, monospace"
            >
              {xLabels[hover]}
            </text>
            {visible.map((s, k) => (
              <g key={s.label}>
                <circle cx={tipX + 11} cy={tipY + 24 + k * 15} r={3} fill={s.color} />
                <text
                  x={tipX + 19}
                  y={tipY + 27 + k * 15}
                  fontSize="10"
                  fill="#cfd6e6"
                  fontFamily="Pretendard, sans-serif"
                >
                  {s.label}
                </text>
                <text
                  x={tipX + tipW - 8}
                  y={tipY + 27 + k * 15}
                  fontSize="10"
                  fill="#fff"
                  textAnchor="end"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {formatValue(s.points[hover] ?? 0)}
                </text>
              </g>
            ))}
          </g>
        )}
      </svg>

      {/* 클릭 토글 범례 */}
      <div className="flex gap-1.5 mt-2.5 flex-wrap">
        {series.map((s) => {
          const off = hidden.has(s.label);
          return (
            <button
              key={s.label}
              type="button"
              onClick={() => toggle(s.label)}
              aria-pressed={!off}
              className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border transition-colors ${
                off
                  ? "border-transparent opacity-45"
                  : "border-hairline bg-surface-2"
              }`}
            >
              <span
                className="w-3.5 h-[3px] rounded-full shrink-0"
                style={{ background: s.color }}
              />
              <span
                className={`text-[11px] ${off ? "line-through text-text-tertiary" : "text-text-secondary"}`}
              >
                {s.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
