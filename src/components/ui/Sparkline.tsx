import { useId } from "react";

interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  fillFrom?: string;
  fillTo?: string;
  className?: string;
}

/// 미니 라인 + 영역 그라데이션 스파크라인. 마지막 포인트에 강조 dot 1개.
export function Sparkline({
  values,
  width = 190,
  height = 84,
  color = "var(--color-azure)",
  fillFrom = "rgba(77,163,255,0.4)",
  fillTo = "rgba(77,163,255,0)",
  className,
}: SparklineProps) {
  const gradientId = `spark-fill-${useId().replace(/:/g, "")}`;
  const padX = 6;

  if (values.length < 2) {
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className}>
        <line
          x1={padX}
          y1={height / 2}
          x2={width - padX}
          y2={height / 2}
          stroke="var(--color-hairline)"
          strokeWidth={1.5}
        />
      </svg>
    );
  }

  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = Math.max(1, max - min);
  const padTop = 10;
  const padBot = 12;
  const innerH = height - padTop - padBot;
  const stepX = values.length > 1 ? (width - padX * 2) / (values.length - 1) : width;

  const points = values.map((v, i) => {
    const x = padX + i * stepX;
    const y = padTop + innerH - ((v - min) / range) * innerH;
    return [x, y] as const;
  });

  const linePath = points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const areaPath = `${linePath} L${points[points.length - 1][0].toFixed(1)},${height} L${padX},${height} Z`;
  const lastPoint = points[points.length - 1];

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className}>
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={fillFrom} />
          <stop offset="100%" stopColor={fillTo} />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradientId})`} />
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={lastPoint[0]} cy={lastPoint[1]} r={3.5} fill={color} />
      <circle cx={lastPoint[0]} cy={lastPoint[1]} r={6} fill={color} opacity={0.25} />
    </svg>
  );
}
