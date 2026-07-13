import { QuotaSegBar } from "@/components/ui/QuotaSegBar";
import { quotaSignalClass } from "@/components/ui/quotaSignal";
import type { OAuthUsage, OAuthUsageWindow } from "@/hooks/useRateLimits";
import type { CodexRateLimitSnapshot, CodexRateLimitWindow } from "@/types/models";

export function ClaudeLimits({
  usage,
  error,
  nowMs,
}: {
  readonly usage: OAuthUsage | null;
  readonly error: string | null;
  readonly nowMs: number;
}) {
  const limits = [
    { label: "5시간 한도", window: usage?.five_hour ?? null },
    { label: "주간 한도", window: usage?.seven_day ?? null },
    { label: "주간 · Sonnet", window: usage?.seven_day_sonnet ?? null },
    { label: "주간 · Opus", window: usage?.seven_day_opus ?? null },
  ].filter((item): item is { label: string; window: OAuthUsageWindow } => item.window !== null);

  if (limits.length === 0) {
    return <LimitEmpty title="Claude OAuth 한도 정보 없음" detail={error} />;
  }
  return (
    <div className="h-full pr-1">
      {limits.map((item) => {
        const resetMs = new Date(item.window.resets_at).getTime();
        const fresh = !usage?.is_stale && resetMs > nowMs;
        return (
          <LimitRow
            key={item.label}
            label={item.label}
            usedPercent={fresh ? item.window.utilization : null}
            resetLabel={fresh ? `${formatRelativeTimeKo(resetMs - nowMs)} 후 초기화` : "갱신 대기"}
          />
        );
      })}
    </div>
  );
}

export function CodexLimits({
  snapshots,
  nowMs,
}: {
  readonly snapshots: readonly CodexRateLimitSnapshot[];
  readonly nowMs: number;
}) {
  const rows = snapshots.flatMap((snapshot) =>
    [snapshot.primary, snapshot.secondary].flatMap((window, index) =>
      window
        ? [{ key: `${snapshot.limit_id}:${index}`, label: limitLabel(snapshot, window), window }]
        : []
    )
  );
  if (rows.length === 0) {
    return (
      <LimitEmpty title="Codex 한도 기록 없음" detail="Codex에서 요청을 실행하면 갱신됩니다." />
    );
  }
  return (
    <div className="h-full pr-1">
      {rows.map((row) => {
        const fresh = row.window.resets_at * 1000 > nowMs;
        return (
          <LimitRow
            key={row.key}
            label={row.label}
            usedPercent={fresh ? row.window.used_percent : null}
            resetLabel={
              fresh
                ? `${formatRelativeTimeKo(row.window.resets_at * 1000 - nowMs)} 후 초기화`
                : "갱신 대기"
            }
          />
        );
      })}
    </div>
  );
}

function limitLabel(snapshot: CodexRateLimitSnapshot, window: CodexRateLimitWindow): string {
  const windowLabel =
    window.window_minutes === 300
      ? "5시간"
      : window.window_minutes === 10_080
        ? "주간"
        : `${window.window_minutes}분`;
  const limitName = snapshot.limit_name?.replace(/^GPT-[^-]+-Codex-/, "Codex ");
  return limitName ? `${limitName} · ${windowLabel}` : `${windowLabel} 한도`;
}

function formatRelativeTimeKo(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}일 ${hours}시간` : `${days}일`;
  if (hours > 0) return minutes > 0 ? `${hours}시간 ${minutes}분` : `${hours}시간`;
  return `${minutes}분`;
}

function LimitRow({
  label,
  usedPercent,
  resetLabel,
}: {
  readonly label: string;
  readonly usedPercent: number | null;
  readonly resetLabel: string;
}) {
  const value = usedPercent === null ? null : Math.min(1, Math.max(0, usedPercent / 100));
  return (
    <div className="mt-4 first:mt-1">
      <div className="flex items-center justify-between mb-2 gap-3">
        <span className="text-[12px] font-semibold text-text-primary truncate" title={label}>
          {label}
        </span>
        <span className="flex items-center gap-2.5 text-[10.5px] text-text-secondary whitespace-nowrap shrink-0">
          {resetLabel}
          <strong
            className={`num text-[13px] font-medium ${value === null ? "text-text-faint" : quotaSignalClass(value)}`}
          >
            {usedPercent === null ? "—" : `${usedPercent.toFixed(1)}%`}
          </strong>
        </span>
      </div>
      <QuotaSegBar value={value} label={`${label} 사용률`} />
    </div>
  );
}

function LimitEmpty({ title, detail }: { readonly title: string; readonly detail: string | null }) {
  return (
    <div className="h-full grid place-items-center rounded-[10px] border border-hairline bg-surface-2 px-6 text-center">
      <div>
        <p className="text-[13px] font-semibold text-text-secondary">{title}</p>
        {detail ? (
          <p className="text-[11px] text-text-tertiary mt-2 leading-relaxed">{detail}</p>
        ) : null}
      </div>
    </div>
  );
}
