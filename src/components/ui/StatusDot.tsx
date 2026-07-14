import { pickQuotaSignal, type QuotaSignal } from "@/components/ui/quotaSignal";

const DOT_BG: Record<QuotaSignal, string> = {
  lime: "var(--color-lime)",
  amber: "var(--color-amber)",
  coral: "var(--color-coral)",
};

/// 3단계 잔여 상태 점 — 한도 패널·계정 한도 페이지 공용 (이모지 대체).
/// remaining: 잔여 비율 0..1, null 이면 갱신 대기(회색).
export function StatusDot({
  remaining,
  size = 8,
}: {
  readonly remaining: number | null;
  readonly size?: number;
}) {
  const background =
    remaining === null ? "var(--color-surface-3)" : DOT_BG[pickQuotaSignal(remaining)];
  return (
    <span
      aria-hidden="true"
      className="inline-block rounded-full shrink-0"
      style={{ width: size, height: size, background }}
    />
  );
}
