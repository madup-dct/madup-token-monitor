export type QuotaSignal = "lime" | "amber" | "coral";

export function pickQuotaSignal(value: number): QuotaSignal {
  if (value >= 0.8) return "coral";
  if (value >= 0.4) return "amber";
  return "lime";
}

export function quotaSignalClass(value: number): string {
  const signal = pickQuotaSignal(Math.max(0, Math.min(1, value)));
  return signal === "lime" ? "text-lime" : signal === "amber" ? "text-amber" : "text-coral";
}
