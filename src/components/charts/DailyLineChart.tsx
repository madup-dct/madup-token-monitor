import { useMemo } from "react";
import { formatTokensCompact, formatUSD } from "@/lib/format";
import { niceTickStep } from "./DailyBarChart";
import { tickY } from "@/lib/usage-math";

interface LineRow {
  date: string;
  tokens: number;
  cost: number;
}

interface Props {
  data: LineRow[];
  highlightLast?: boolean;
  metric?: "tokens" | "cost";
  avg?: number | null;
}

const CHART_W = 720;
const CHART_H = 280;
const Y_AXIS_W = 50;
const PAD_TOP = 16;
const PAD_BOT = 28;

/// 라인 차트 — 막대로 표현하기엔 데이터 포인트가 많을 때 (예: 90 일+) 사용.
/// 같은 dimension/그라데이션/평균선 stylistics 를 유지해 DailyBarChart 와 시각 통일.
export function DailyLineChart({
  data,
  highlightLast = true,
  metric = "tokens",
  avg = null,
}: Props) {
  const rows = data;
  const hasData = rows.length > 0;

  const { maxVal, ticks, computedAvg } = useMemo(() => {
    const vals = rows.map((r) => (metric === "tokens" ? r.tokens : r.cost));
    const max = Math.max(...vals, 1);
    const tick = niceTickStep(max / 4);
    const top = Math.ceil(max / tick) * tick;
    const ts = [top, top * 0.75, top * 0.5, top * 0.25];
    const sum = vals.reduce((a, b) => a + b, 0);
    const computed = vals.length > 0 ? sum / vals.length : 0;
    return { maxVal: top, ticks: ts, computedAvg: computed };
  }, [rows, metric]);

  if (!hasData) {
    return (
      <div className="h-[280px] grid place-items-center text-text-tertiary text-[12px]">
        기록 없음
      </div>
    );
  }

  const innerW = CHART_W - Y_AXIS_W;
  const innerH = CHART_H - PAD_TOP - PAD_BOT;
  const colW = innerW / Math.max(rows.length - 1, 1);
  const avgValue = avg ?? computedAvg;
  const avgY = PAD_TOP + innerH - (avgValue / maxVal) * innerH;
  const fmt = metric === "tokens" ? formatTokensCompact : (n: number) => formatUSD(n);

  // line points
  const points = rows.map((r, i) => {
    const v = metric === "tokens" ? r.tokens : r.cost;
    return {
      x: Y_AXIS_W + i * colW,
      y: PAD_TOP + innerH - (v / maxVal) * innerH,
      v,
      date: r.date,
      isLast: i === rows.length - 1,
    };
  });

  const linePath = points.map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`)).join(" ");
  const areaPath = `${linePath} L ${points[points.length - 1]!.x} ${PAD_TOP + innerH} L ${points[0]!.x} ${PAD_TOP + innerH} Z`;

  return (
    <svg
      width="100%"
      height={CHART_H}
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ display: "block" }}
    >
      <defs>
        <linearGradient id="lineGradArea" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#7BBCFF" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#2C7BE5" stopOpacity="0" />
        </linearGradient>
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
              {fmt(t)}
            </text>
          );
        })}
      </g>

      {/* area */}
      <path d={areaPath} fill="url(#lineGradArea)" />

      {/* line */}
      <path
        d={linePath}
        fill="none"
        stroke="#4DA3FF"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* dots — 90+ 일에서 라벨/점 너무 많아 thin-out (매 N 번째 + 마지막 항상) */}
      {(() => {
        const step = Math.max(1, Math.ceil(36 / Math.max(colW, 1)));
        return points.map((p, i) => {
          const isToday = highlightLast && p.isLast;
          const showDot = isToday || i % step === 0;
          if (!showDot) return null;
          return (
            <circle
              key={`d-${i}`}
              cx={p.x}
              cy={p.y}
              r={isToday ? 4 : 2.5}
              fill={isToday ? "#B68CFF" : "#4DA3FF"}
              stroke={isToday ? "#1A1F36" : "none"}
              strokeWidth={isToday ? 1.5 : 0}
            />
          );
        });
      })()}

      {/* x-axis labels — 매 N 번째 (오늘 항상) */}
      <g fill="#6A7593" fontSize="10.5" fontFamily="JetBrains Mono, monospace">
        {(() => {
          const step = Math.max(1, Math.ceil(36 / Math.max(colW, 1)));
          return points.map((p, i) => {
            const isToday = highlightLast && p.isLast;
            const showLabel = isToday || i % step === 0;
            if (!showLabel) return null;
            return (
              <text
                key={`x-${i}`}
                x={p.x}
                y={CHART_H - 8}
                textAnchor="middle"
                fill={isToday ? "#B68CFF" : "#6A7593"}
                fontWeight={isToday ? 600 : 400}
                fontFamily={isToday ? "Pretendard, sans-serif" : "JetBrains Mono, monospace"}
              >
                {isToday ? "오늘" : p.date}
              </text>
            );
          });
        })()}
      </g>

      {/* avg dashed line */}
      {avgValue > 0 && (
        <g>
          <line
            x1={Y_AXIS_W}
            y1={avgY}
            x2={CHART_W}
            y2={avgY}
            stroke="#F5B544"
            strokeWidth={1.2}
            strokeDasharray="4 4"
            opacity={0.85}
          />
          <text
            x={CHART_W - 8}
            y={avgY - 4}
            textAnchor="end"
            fontSize="9.5"
            fill="#F5B544"
            fontFamily="Pretendard, sans-serif"
            fontWeight={500}
          >
            평균 · {fmt(avgValue)}
          </text>
        </g>
      )}
    </svg>
  );
}
