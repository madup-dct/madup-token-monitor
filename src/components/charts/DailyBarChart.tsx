import { useMemo } from "react";
import { formatTokensCompact, formatUSD } from "@/lib/format";
import { tickY } from "@/lib/usage-math";

interface DailyBarRow {
  date: string;
  tokens: number;
  cost: number;
}

interface Props {
  data: DailyBarRow[];
  /// 마지막 row 가 "오늘" 인지 여부. true 면 violet 강조.
  highlightLast?: boolean;
  metric?: "tokens" | "cost";
  /// 평균 라인 표시. 미지정 시 자동 계산 (data 의 평균).
  avg?: number | null;
}

const CHART_W = 720;
const CHART_H = 280;
const Y_AXIS_W = 50;
const PAD_TOP = 16;
const PAD_BOT = 28;
const BAR_GAP = 10;

/// 막대 차트 — azure 그라데이션 (이전 기간) + violet 그라데이션 (오늘 / 마지막) + amber dashed 평균 라인.
/// y 축 4 단계 + x 축 라벨, 막대 위 값 노출. responsive 하게 viewBox 확대 / 축소.
export function DailyBarChart({
  data,
  highlightLast = true,
  metric = "tokens",
  avg = null,
}: Props) {
  const rows = data;
  const hasData = rows.length > 0;

  const { values, maxVal, ticks, computedAvg } = useMemo(() => {
    const vals = rows.map((r) => (metric === "tokens" ? r.tokens : r.cost));
    const max = Math.max(...vals, 1);
    // y axis: 4 ticks, rounded up to nearest "nice" number
    const tick = niceTickStep(max / 4);
    const top = Math.ceil(max / tick) * tick;
    const ts = [top, top * 0.75, top * 0.5, top * 0.25];
    const sum = vals.reduce((a, b) => a + b, 0);
    const computed = vals.length > 0 ? sum / vals.length : 0;
    return { values: vals, maxVal: top, ticks: ts, computedAvg: computed };
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
  const colW = innerW / rows.length;
  const barW = Math.max(20, colW - BAR_GAP);

  const avgValue = avg ?? computedAvg;
  const avgY = PAD_TOP + innerH - (avgValue / maxVal) * innerH;

  const fmt = metric === "tokens" ? formatTokensCompact : (n: number) => formatUSD(n);

  return (
    <svg
      width="100%"
      height={CHART_H}
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ display: "block" }}
    >
      <defs>
        <linearGradient id="barGradAzure" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#7BBCFF" />
          <stop offset="100%" stopColor="#2C7BE5" />
        </linearGradient>
        <linearGradient id="barGradToday" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#B68CFF" />
          <stop offset="100%" stopColor="#8358D9" />
        </linearGradient>
      </defs>

      {/* horizontal gridlines */}
      <g stroke="rgba(255,255,255,0.05)" strokeWidth={1}>
        {ticks.map((t, i) => {
          const y = tickY(t, maxVal, PAD_TOP, innerH);
          return (
            <line key={i} x1={Y_AXIS_W} y1={y} x2={CHART_W} y2={y} />
          );
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

      {/* bars */}
      <g>
        {rows.map((r, i) => {
          const v = values[i];
          const isToday = highlightLast && i === rows.length - 1;
          const h = (v / maxVal) * innerH;
          const x = Y_AXIS_W + i * colW + (colW - barW) / 2;
          const y = PAD_TOP + innerH - h;
          const fillId = isToday ? "barGradToday" : "barGradAzure";
          return (
            <g key={r.date}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={Math.max(2, h)}
                rx={6}
                fill={`url(#${fillId})`}
                opacity={isToday ? 1 : 0.92}
              />
              {h > 18 && (
                <text
                  x={x + barW / 2}
                  // 평균 점선과 세로로 겹치면 선 위로 피신 — 라벨이 점선에 얹혀 읽기 어려운 것 방지.
                  y={avgValue > 0 && Math.abs(y - 6 - avgY) < 11 ? Math.min(y - 6, avgY - 11) : y - 6}
                  textAnchor="middle"
                  fontSize="10"
                  fontFamily="JetBrains Mono, monospace"
                  fill={isToday ? "#B68CFF" : "#9CA8C5"}
                  fontWeight={isToday ? 600 : 400}
                >
                  {fmt(v)}
                </text>
              )}
            </g>
          );
        })}
      </g>

      {/* baseline */}
      <line
        x1={Y_AXIS_W}
        y1={PAD_TOP + innerH}
        x2={CHART_W}
        y2={PAD_TOP + innerH}
        stroke="rgba(255,255,255,0.12)"
        strokeWidth={1}
      />

      {/* x-axis labels — 라벨이 많으면 매 N 번째만 노출 (마지막=오늘 항상) */}
      <g fill="#6A7593" fontSize="10.5" fontFamily="JetBrains Mono, monospace">
        {(() => {
          // 평균 라벨 폭 ~ 36px 기준. colW 가 그보다 작으면 thin-out.
          const step = Math.max(1, Math.ceil(36 / Math.max(colW, 1)));
          return rows.map((r, i) => {
            const isToday = highlightLast && i === rows.length - 1;
            const showLabel = isToday || i % step === 0;
            if (!showLabel) return null;
            const x = Y_AXIS_W + i * colW + colW / 2;
            return (
              <text
                key={r.date}
                x={x}
                y={CHART_H - 8}
                textAnchor="middle"
                fill={isToday ? "#B68CFF" : "#6A7593"}
                fontWeight={isToday ? 600 : 400}
                fontFamily={isToday ? "Pretendard, sans-serif" : "JetBrains Mono, monospace"}
              >
                {isToday ? "오늘" : r.date}
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
            opacity={0.7}
          />
          {/* 라벨 뒤 어두운 백드롭 — 마지막 막대 값 라벨과 겹쳐도 판독 가능하게 */}
          {(() => {
            const label = `평균 · ${fmt(avgValue)}`;
            const w = 8 + label.length * 7;
            return (
              <>
                <rect
                  x={CHART_W - 4 - w}
                  y={avgY - 14.5}
                  width={w}
                  height={13}
                  rx={6.5}
                  fill="#0B1020"
                  opacity={0.85}
                />
                <text
                  x={CHART_W - 8}
                  y={avgY - 5}
                  textAnchor="end"
                  fontSize="9.5"
                  fill="#F5B544"
                  fontFamily="Pretendard, sans-serif"
                  fontWeight={500}
                >
                  {label}
                </text>
              </>
            );
          })()}
        </g>
      )}
    </svg>
  );
}

export function niceTickStep(roughStep: number): number {
  if (roughStep <= 0) return 1;
  const exp = Math.floor(Math.log10(roughStep));
  const base = Math.pow(10, exp);
  const m = roughStep / base;
  // 1, 2, 2.5, 5, 10
  let nice;
  if (m < 1.5) nice = 1;
  else if (m < 2.25) nice = 2;
  else if (m < 3.5) nice = 2.5;
  else if (m < 7.5) nice = 5;
  else nice = 10;
  return nice * base;
}
