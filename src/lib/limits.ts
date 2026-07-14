// Claude 한도 표시 공통 로직 — 잔여 %(배터리) 변환, 라벨, 리셋 포맷, 정렬.
// UsageLimitPanel(대시보드) 과 AccountLimits(계정 한도 페이지) 가 공유한다.
import type { LimitWindow } from "@/types/models";

export function remainingPct(utilization: number): number {
  return Math.round(Math.min(100, Math.max(0, 100 - utilization)));
}

/// 표기 숫자는 사용률 % (2026-07-14 통일 — 트레이·패널·계정 한도 페이지 공통).
/// 신호색·정렬은 여전히 잔여(remainingPct) 기준.
export function usedPct(utilization: number): number {
  return Math.round(Math.min(100, Math.max(0, utilization)));
}

export function windowLabel(w: LimitWindow): string {
  if (w.kind === "session") return "5시간 한도";
  if (w.kind === "weekly_all") return "주간 한도";
  if (w.kind === "weekly_scoped") return `주간 · ${w.scope_model ?? "모델"}`;
  return w.kind;
}

export function windowShortLabel(w: LimitWindow): string {
  if (w.kind === "session") return "5h";
  if (w.kind === "weekly_all") return "7d";
  const base = w.scope_model ?? w.kind;
  return base.slice(0, 1).toUpperCase();
}

/// "07/14 00:59" — 로컬 tz(KST). 리셋 절대 시각 표기.
export function formatResetKo(ms: number): string {
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi}`;
}

/// "3일 2시간" / "2시간 30분" / "5분" — hover 보조 표기.
export function formatRelativeTimeKo(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}일 ${hours}시간` : `${days}일`;
  if (hours > 0) return minutes > 0 ? `${hours}시간 ${minutes}분` : `${hours}시간`;
  return `${minutes}분`;
}

export function minRemaining(windows: readonly LimitWindow[]): number | null {
  if (windows.length === 0) return null;
  return Math.min(...windows.map((w) => remainingPct(w.utilization)));
}

export type SortKind = "session" | "weekly_all" | "weekly_scoped";

export function windowOfKind(
  windows: readonly LimitWindow[],
  kind: SortKind,
): LimitWindow | null {
  return windows.find((w) => w.kind === kind) ?? null;
}

/// 잔여 많은 순 정렬 — "쉐어 요청할 계정" 이 위로. 해당 창이 없는 row 는 마지막.
export function sortByRemainingDesc<T>(
  rows: readonly T[],
  windowsOf: (row: T) => readonly LimitWindow[],
  kind: SortKind,
): T[] {
  return [...rows].sort((a, b) => {
    const wa = windowOfKind(windowsOf(a), kind);
    const wb = windowOfKind(windowsOf(b), kind);
    const va = wa ? remainingPct(wa.utilization) : -1;
    const vb = wb ? remainingPct(wb.utilization) : -1;
    return vb - va;
  });
}
