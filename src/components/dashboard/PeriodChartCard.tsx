import type { ReactNode } from "react";
import { DailyBarChart } from "@/components/charts/DailyBarChart";
import { DailyLineChart } from "@/components/charts/DailyLineChart";
import { Segmented } from "@/components/ui/Segmented";
import { Legend } from "@/components/ui/Legend";
import { formatTokensCompact, formatUSD } from "@/lib/format";

export interface PeriodRow {
  date: string;
  tokens: number;
  cost: number;
}

export interface PeriodChartCardProps {
  /// 좌측 헤더 노드 (제목 + Select 들) — 부모가 직접 구성.
  leftHeader: ReactNode;
  /// 사전 집계된 row.
  rows: PeriodRow[];
  metric: "tokens" | "cost";
  onMetricChange: (m: "tokens" | "cost") => void;
  view: "chart" | "list";
  onViewChange: (v: "chart" | "list") => void;
  highlightLast?: boolean;
  /// 차트/리스트에서 row.date 를 어떻게 표시할지. 미지정 시 그대로.
  labelFormat?: (row: PeriodRow, index: number) => string;
  /// Copy 버튼 클릭 (없으면 footer 의 copy 안 보임).
  onCopy?: () => void;
  emptyText?: string;
  colSpan?: 8 | 12;
  /// 차트 타입. 'auto' (기본): rows.length > 45 면 line, 아니면 bar.
  /// 명시적으로 'bar' / 'line' 지정 가능.
  chartType?: "auto" | "bar" | "line";
}

/// 대시보드 공통 "기간별 사용량" 카드 — Dashboard / UserDashboard 동일 시각.
/// 헤더의 granularity / range Select 는 페이지마다 다르므로 leftHeader 슬롯으로 위임.
export function PeriodChartCard({
  leftHeader,
  rows,
  metric,
  onMetricChange,
  view,
  onViewChange,
  highlightLast = true,
  labelFormat,
  onCopy,
  emptyText = "기록 없음",
  colSpan = 8,
  chartType = "auto",
}: PeriodChartCardProps) {
  const labeled = rows.map((r, i) => ({
    date: labelFormat ? labelFormat(r, i) : r.date,
    tokens: r.tokens,
    cost: r.cost,
  }));
  const maxVal = Math.max(...rows.map((r) => (metric === "tokens" ? r.tokens : r.cost)), 1);
  const resolvedChartType: "bar" | "line" =
    chartType === "auto" ? (rows.length > 45 ? "line" : "bar") : chartType;

  return (
    <section className={`mc-card ${colSpan === 12 ? "col-span-12" : "col-span-8"}`}>
      <header className="flex items-center justify-between mb-3.5 gap-3 relative flex-wrap">
        <div className="flex items-center gap-2">{leftHeader}</div>
        <div className="flex items-center gap-2 shrink-0">
          <Segmented
            value={metric}
            onChange={(v) => onMetricChange(v as "tokens" | "cost")}
            options={[
              { value: "tokens", label: "Tokens" },
              { value: "cost", label: "Cost" },
            ]}
            ariaLabel="지표 선택"
          />
          <Segmented
            value={view}
            onChange={(v) => onViewChange(v as "chart" | "list")}
            options={[
              { value: "chart", label: "Chart" },
              { value: "list", label: "List" },
            ]}
            ariaLabel="보기 전환"
          />
        </div>
      </header>

      <div
        className="rounded-[10px] border border-hairline p-4"
        style={{ background: "var(--color-surface-2)" }}
      >
        {view === "chart" ? (
          resolvedChartType === "line" ? (
            <DailyLineChart data={labeled} metric={metric} highlightLast={highlightLast} />
          ) : (
            <DailyBarChart data={labeled} metric={metric} highlightLast={highlightLast} />
          )
        ) : (
          <div className="max-h-[280px] overflow-y-auto -mx-2">
            {rows.length === 0 ? (
              <p className="text-[12px] text-text-tertiary py-4 text-center">{emptyText}</p>
            ) : (
              rows.map((d, i) => {
                const v = metric === "tokens" ? d.tokens : d.cost;
                const empty = v === 0;
                return (
                  <div
                    key={d.date}
                    className={`flex items-center justify-between px-2 py-2 ${
                      i > 0 ? "border-t border-hairline" : ""
                    } ${empty ? "opacity-50" : ""}`}
                  >
                    <span className="num text-[12px] text-text-secondary font-medium whitespace-nowrap">
                      {labelFormat ? labelFormat(d, i) : d.date}
                    </span>
                    <div className="flex items-center gap-3 flex-1 ml-3">
                      <div className="flex-1 h-1 bg-surface-3 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: empty ? "0%" : `${Math.max(2, (v / maxVal) * 100)}%`,
                            background:
                              "linear-gradient(90deg, var(--color-azure-deep), var(--color-azure))",
                          }}
                        />
                      </div>
                      <span
                        className={`num text-[13px] font-medium whitespace-nowrap ${empty ? "text-text-faint" : "text-azure"}`}
                      >
                        {empty
                          ? "—"
                          : metric === "tokens"
                            ? formatTokensCompact(d.tokens)
                            : formatUSD(d.cost)}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      <div className="flex justify-between items-center mt-3.5">
        <div className="flex gap-3.5 text-[11px] text-text-tertiary">
          <Legend swatch="var(--color-azure)" label="Tokens (입력+출력+캐시)" shape="dot" />
          <Legend swatch="var(--color-violet)" label="오늘" shape="dot" />
          <Legend swatch="var(--color-amber)" label="평균" shape="dashed" />
        </div>
        {onCopy ? (
          <button
            onClick={onCopy}
            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-hairline bg-surface-2 text-text-secondary text-[11.5px] font-medium hover:text-text-primary hover:border-hairline-strong transition-colors"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <rect x="2" y="2" width="9" height="9" rx="1" />
              <path d="M5 5h6v6" />
            </svg>
            Copy
          </button>
        ) : null}
      </div>
    </section>
  );
}

