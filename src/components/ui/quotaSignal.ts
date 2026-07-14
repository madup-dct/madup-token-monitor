export type QuotaSignal = "lime" | "amber" | "coral";

/// 입력은 "잔여 비율" 0..1 (배터리 의미). 잔여 ≥70% 여유 / ≥30% 주의 / <30% 위험.
export function pickQuotaSignal(remaining: number): QuotaSignal {
  if (remaining >= 0.7) return "lime";
  if (remaining >= 0.3) return "amber";
  return "coral";
}

export function quotaSignalClass(remaining: number): string {
  const signal = pickQuotaSignal(Math.max(0, Math.min(1, remaining)));
  return signal === "lime" ? "text-lime" : signal === "amber" ? "text-amber" : "text-coral";
}
