import { QuotaSegBar } from "@/components/ui/QuotaSegBar";
import { StatusDot } from "@/components/ui/StatusDot";
import { quotaSignalClass } from "@/components/ui/quotaSignal";
import {
  formatRelativeTimeKo,
  formatResetKo,
  usedPct,
  windowLabel,
} from "@/lib/limits";
import type { OAuthUsage } from "@/hooks/useRateLimits";
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
  const windows = usage?.windows ?? [];
  if (windows.length === 0) {
    return <LimitEmpty title="Claude OAuth 한도 정보 없음" detail={error} />;
  }
  return (
    <div className="h-full pr-1">
      {windows.map((w, i) => {
        const resetMs = new Date(w.resets_at).getTime();
        const fresh = !usage?.is_stale && Number.isFinite(resetMs) && resetMs > nowMs;
        return (
          <LimitRow
            key={`${w.kind}:${w.scope_model ?? i}`}
            label={windowLabel(w)}
            usedPercent={fresh ? usedPct(w.utilization) : null}
            resetMs={fresh ? resetMs : null}
            nowMs={nowMs}
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
        const resetMs = row.window.resets_at * 1000;
        const fresh = resetMs > nowMs;
        return (
          <LimitRow
            key={row.key}
            label={row.label}
            usedPercent={fresh ? usedPct(row.window.used_percent) : null}
            resetMs={fresh ? resetMs : null}
            nowMs={nowMs}
          />
        );
      })}
    </div>
  );
}

function limitLabel(snapshot: CodexRateLimitSnapshot, window: CodexRateLimitWindow): string {
  const periodLabel =
    window.window_minutes === 300
      ? "5시간"
      : window.window_minutes === 10_080
        ? "주간"
        : `${window.window_minutes}분`;
  const limitName = snapshot.limit_name?.replace(/^GPT-[^-]+-Codex-/, "Codex ");
  return limitName ? `${limitName} · ${periodLabel}` : `${periodLabel} 한도`;
}

function LimitRow({
  label,
  usedPercent,
  resetMs,
  nowMs,
}: {
  readonly label: string;
  readonly usedPercent: number | null; // null = 갱신 대기
  readonly resetMs: number | null;
  readonly nowMs: number;
}) {
  // 표기 숫자·게이지 채움·상태색 모두 사용률 기준 (2026-07-14 통일).
  const used = usedPercent === null ? null : Math.min(1, Math.max(0, usedPercent / 100));
  const resetLabel = resetMs === null ? "갱신 대기" : `리셋 ${formatResetKo(resetMs)}`;
  const resetTitle =
    resetMs === null ? undefined : `${formatRelativeTimeKo(resetMs - nowMs)} 후 초기화`;
  return (
    <div className="mt-4 first:mt-1">
      <div className="flex items-center justify-between mb-2 gap-3">
        <span className="flex items-center gap-2 min-w-0">
          <StatusDot used={used} />
          <span className="text-[12px] font-semibold text-text-primary truncate" title={label}>
            {label}
          </span>
        </span>
        <span
          className="flex items-center gap-2.5 text-[10.5px] text-text-secondary whitespace-nowrap shrink-0"
          title={resetTitle}
        >
          {resetLabel}
          <strong
            className={`num text-[13px] font-medium ${used === null ? "text-text-faint" : quotaSignalClass(used)}`}
          >
            {usedPercent === null ? "—" : `사용 ${usedPercent}%`}
          </strong>
        </span>
      </div>
      <QuotaSegBar value={used} label={`${label} 사용률`} />
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
