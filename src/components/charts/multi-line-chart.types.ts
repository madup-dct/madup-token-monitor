export interface LineSeries {
  label: string;
  color: string;
  points: number[];
}

export interface MultiLineChartProps {
  series: LineSeries[];
  xLabels: string[];
  formatValue: (value: number) => string;
  height?: number;
}
