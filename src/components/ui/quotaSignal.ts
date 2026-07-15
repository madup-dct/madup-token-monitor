export type QuotaSignal = "lime" | "amber" | "coral";

/// 입력은 "사용률" 0..1. 사용률 <40% 여유(초록) / 40~70% 주의(주황) / ≥70% 위험(빨강).
export function pickQuotaSignal(used: number): QuotaSignal {
  if (used < 0.4) return "lime";
  if (used < 0.7) return "amber";
  return "coral";
}

export function quotaSignalClass(used: number): string {
  const signal = pickQuotaSignal(Math.max(0, Math.min(1, used)));
  return signal === "lime" ? "text-lime" : signal === "amber" ? "text-amber" : "text-coral";
}
