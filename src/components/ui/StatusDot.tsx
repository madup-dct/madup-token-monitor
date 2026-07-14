import { pickQuotaSignal, type QuotaSignal } from "@/components/ui/quotaSignal";

const DOT_BG: Record<QuotaSignal, string> = {
  lime: "var(--color-lime)",
  orange: "var(--color-orange)",
  coral: "var(--color-coral)",
};

/// 3단계 사용률 상태 점 — 한도 패널·계정 한도 페이지 공용 (이모지 대체).
/// used: 사용률 0..1, null 이면 갱신 대기(회색).
export function StatusDot({
  used,
  size = 8,
}: {
  readonly used: number | null;
  readonly size?: number;
}) {
  const background =
    used === null ? "var(--color-surface-3)" : DOT_BG[pickQuotaSignal(used)];
  return (
    <span
      aria-hidden="true"
      className="inline-block rounded-full shrink-0"
      style={{ width: size, height: size, background }}
    />
  );
}
