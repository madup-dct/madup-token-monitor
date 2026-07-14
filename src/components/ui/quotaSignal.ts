export type QuotaSignal = "lime" | "orange" | "coral";

/// 입력은 "잔여 비율" 0..1. 잔여 ≥70% 여유(초록) / 40~70% 주의(주황) / <40% 위험(빨강).
export function pickQuotaSignal(remaining: number): QuotaSignal {
  if (remaining >= 0.7) return "lime";
  if (remaining >= 0.4) return "orange";
  return "coral";
}

export function quotaSignalClass(remaining: number): string {
  const signal = pickQuotaSignal(Math.max(0, Math.min(1, remaining)));
  return signal === "lime" ? "text-lime" : signal === "orange" ? "text-orange" : "text-coral";
}
