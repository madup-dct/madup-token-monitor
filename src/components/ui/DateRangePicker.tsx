import { useEffect, useMemo, useRef, useState } from "react";
import { DropdownPortal } from "./DropdownPortal";

export interface DateRange {
  start: string; // YYYY-MM-DD (로컬, inclusive)
  end: string; // YYYY-MM-DD (로컬, inclusive)
}

interface DateRangePickerProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
  ariaLabel?: string;
  className?: string;
}

const WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function parseYmd(s: string): Date {
  return new Date(s + "T00:00:00");
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function startOfWeekMon(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function shortLabel(s: string): string {
  const d = parseYmd(s);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/// 월요일 시작 6주(42칸) 그리드 — 선택 월 기준.
function monthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7; // Mon=0
  const gridStart = addDays(first, -lead);
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
}

/// 커스텀 날짜범위 선택기 — 라이브러리 없이 디자인시스템 톤(mc-select + DropdownPortal + azure)에 맞춤.
/// 프리셋(오늘/이번주/이번달/최근7일/최근30일) + 월 캘린더 범위 선택(시작 클릭 → 종료 클릭).
export function DateRangePicker({ value, onChange, ariaLabel, className = "" }: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [pendingStart, setPendingStart] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);
  const todayKey = ymd(today);

  const [view, setView] = useState(() => {
    const d = parseYmd(value.end);
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  // 열릴 때 view 를 종료일 월로 맞추고 진행중 선택 초기화.
  useEffect(() => {
    if (open) {
      const d = parseYmd(value.end);
      setView({ year: d.getFullYear(), month: d.getMonth() });
      setPendingStart(null);
    }
  }, [open, value.end]);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      const t = e.target as Node;
      if (!buttonRef.current?.contains(t) && !popoverRef.current?.contains(t)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const triggerLabel =
    value.start === value.end ? shortLabel(value.start) : `${shortLabel(value.start)} ~ ${shortLabel(value.end)}`;

  const grid = useMemo(() => monthGrid(view.year, view.month), [view]);

  function commit(range: DateRange) {
    onChange(range);
    setPendingStart(null);
    setOpen(false);
  }

  function applyPreset(kind: "today" | "week" | "month" | "d7" | "d30") {
    if (kind === "today") return commit({ start: todayKey, end: todayKey });
    if (kind === "week") return commit({ start: ymd(startOfWeekMon(today)), end: todayKey });
    if (kind === "month")
      return commit({ start: ymd(new Date(today.getFullYear(), today.getMonth(), 1)), end: todayKey });
    if (kind === "d7") return commit({ start: ymd(addDays(today, -6)), end: todayKey });
    return commit({ start: ymd(addDays(today, -29)), end: todayKey });
  }

  function onDayClick(dayKey: string) {
    if (dayKey > todayKey) return; // 미래 비활성
    if (!pendingStart) {
      setPendingStart(dayKey);
      return;
    }
    if (dayKey >= pendingStart) commit({ start: pendingStart, end: dayKey });
    else commit({ start: dayKey, end: pendingStart });
  }

  // 하이라이트 기준: 진행중이면 pendingStart 한 점, 아니면 확정 범위.
  const hiStart = pendingStart ?? value.start;
  const hiEnd = pendingStart ?? value.end;

  const PRESETS: { kind: Parameters<typeof applyPreset>[0]; label: string }[] = [
    { kind: "today", label: "오늘" },
    { kind: "week", label: "이번 주" },
    { kind: "month", label: "이번 달" },
    { kind: "d7", label: "최근 7일" },
    { kind: "d30", label: "최근 30일" },
  ];

  return (
    <div className={`relative inline-block ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={ariaLabel ?? "날짜 범위 선택"}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="mc-select"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="shrink-0" aria-hidden>
          <rect x="2.5" y="3" width="11" height="11" rx="1.5" />
          <path d="M2.5 6.5h11M5.5 1.8v2.2M10.5 1.8v2.2" strokeLinecap="round" />
        </svg>
        <span className="num">{triggerLabel}</span>
        <svg
          width="9"
          height="9"
          viewBox="0 0 12 12"
          className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        >
          <path d="M3 4.5 L6 7.5 L9 4.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <DropdownPortal
        anchorRef={buttonRef}
        open={open}
        menuRef={popoverRef}
        align="right"
        matchWidth={false}
        role="dialog"
        className="rounded-lg border border-hairline overflow-hidden"
        style={{ background: "var(--color-surface-2)", boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}
      >
        <div className="flex">
          {/* Presets */}
          <div className="flex flex-col gap-1 p-2.5 border-r border-hairline min-w-[104px]">
            {PRESETS.map((p) => (
              <button
                key={p.kind}
                type="button"
                onClick={() => applyPreset(p.kind)}
                className="text-left px-2.5 py-1.5 rounded-md text-[12px] font-medium text-text-secondary hover:text-text-primary hover:bg-surface-3 transition-colors whitespace-nowrap"
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Calendar */}
          <div className="p-3 w-[252px]">
            {/* Month nav */}
            <div className="flex items-center justify-between mb-2.5">
              <button
                type="button"
                onClick={() =>
                  setView((v) => {
                    const d = new Date(v.year, v.month - 1, 1);
                    return { year: d.getFullYear(), month: d.getMonth() };
                  })
                }
                aria-label="이전 달"
                className="mc-icon-btn"
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 3L5 8l5 5" />
                </svg>
              </button>
              <span className="text-[12.5px] font-semibold text-text-primary num">
                {view.year}년 {view.month + 1}월
              </span>
              <button
                type="button"
                onClick={() =>
                  setView((v) => {
                    const d = new Date(v.year, v.month + 1, 1);
                    return { year: d.getFullYear(), month: d.getMonth() };
                  })
                }
                aria-label="다음 달"
                className="mc-icon-btn"
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 3l5 5-5 5" />
                </svg>
              </button>
            </div>

            {/* Weekday header */}
            <div className="grid grid-cols-7 mb-1">
              {WEEKDAYS.map((w, i) => (
                <div
                  key={w}
                  className={`text-center text-[10px] font-bold py-1 ${i >= 5 ? "text-text-faint" : "text-text-tertiary"}`}
                >
                  {w}
                </div>
              ))}
            </div>

            {/* Day grid */}
            <div className="grid grid-cols-7 gap-y-0.5">
              {grid.map((d) => {
                const key = ymd(d);
                const inMonth = d.getMonth() === view.month;
                const future = key > todayKey;
                const isStart = key === hiStart;
                const isEnd = key === hiEnd;
                const inRange = key >= hiStart && key <= hiEnd;
                const isToday = key === todayKey;
                const edge = isStart || isEnd;
                return (
                  <button
                    key={key}
                    type="button"
                    disabled={future}
                    onClick={() => onDayClick(key)}
                    className={`relative h-7 text-[12px] num transition-colors ${
                      inRange && !edge ? "bg-azure-soft" : ""
                    } ${inRange ? (key === hiStart ? "rounded-l-md" : key === hiEnd ? "rounded-r-md" : "") : ""}`}
                  >
                    <span
                      className={`absolute inset-0 m-auto w-7 h-7 flex items-center justify-center rounded-md transition-colors ${
                        edge
                          ? "bg-azure text-white font-semibold"
                          : future
                            ? "text-text-faint/40 cursor-not-allowed"
                            : inMonth
                              ? "text-text-secondary hover:bg-surface-3"
                              : "text-text-faint hover:bg-surface-3"
                      }`}
                    >
                      {d.getDate()}
                      {isToday && !edge ? (
                        <span className="absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-azure" />
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="mt-2.5 pt-2 border-t border-hairline text-[10.5px] text-text-tertiary text-center">
              {pendingStart ? "종료일을 선택하세요" : `${shortLabel(value.start)} ~ ${shortLabel(value.end)}`}
            </div>
          </div>
        </div>
      </DropdownPortal>
    </div>
  );
}
