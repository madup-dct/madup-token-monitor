import { useEffect, useState } from "react";
import { QuotaSegBar } from "@/components/ui/QuotaSegBar";
import { Segmented } from "@/components/ui/Segmented";
import { StatusDot } from "@/components/ui/StatusDot";
import { quotaSignalClass } from "@/components/ui/quotaSignal";
import { useAccountLimits } from "@/hooks/useRateLimits";
import {
  formatRelativeTimeKo,
  formatResetKo,
  minRemaining,
  sortByRemainingDesc,
  usedPct,
  windowShortLabel,
  type SortKind,
} from "@/lib/limits";
import type { AccountLimitRow } from "@/types/models";

const SORT_OPTIONS: { value: SortKind; label: string }[] = [
  { value: "weekly_all", label: "주간" },
  { value: "session", label: "5시간" },
  { value: "weekly_scoped", label: "모델" },
];

/// 마지막 갱신 30분 초과 → 흐리게 (죽은 데이터 오인 방지, 스펙 §4.4).
const STALE_MS = 30 * 60_000;

export default function AccountLimits() {
  const { data: rows = [], isLoading, error } = useAccountLimits();
  const [sortKind, setSortKind] = useState<SortKind>("weekly_scoped");
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const sorted = sortByRemainingDesc(
    rows,
    (row) => row.windows.filter((window) => new Date(window.resets_at).getTime() > nowMs),
    sortKind
  );

  return (
    <div className="px-7 pt-5 pb-8">
      <header className="flex items-center justify-between mb-5 gap-3">
        <div>
          <h1 className="text-[18px] font-bold text-text-primary">계정 한도</h1>
          <p className="text-[12px] text-text-tertiary mt-1">
            계정별 Claude·Codex 한도 사용률 — 여유 있는 계정에 쉐어를 요청하세요.
          </p>
        </div>
        {/* 정렬 기준(어느 창 여유 순). 계정이 2개 이상일 때만 — 1개면 정렬이 무의미. */}
        {sorted.length > 1 ? (
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[11px] text-text-tertiary whitespace-nowrap">여유 정렬</span>
            <Segmented
              value={sortKind}
              onChange={setSortKind}
              options={SORT_OPTIONS}
              ariaLabel="정렬 기준 한도 창"
            />
          </div>
        ) : null}
      </header>

      {isLoading ? (
        <EmptyState text="불러오는 중…" />
      ) : error ? (
        <EmptyState text={`조회 실패: ${error instanceof Error ? error.message : String(error)}`} />
      ) : sorted.length === 0 ? (
        <EmptyState text="아직 수집된 계정 한도가 없습니다. 각자 앱을 실행하고 있으면 자동으로 올라옵니다." />
      ) : (
        <div className="flex flex-col gap-2">
          {sorted.map((row) => (
            <AccountRow key={`${row.provider}:${row.account_id}`} row={row} nowMs={nowMs} />
          ))}
        </div>
      )}
    </div>
  );
}

function AccountRow({ row, nowMs }: { readonly row: AccountLimitRow; readonly nowMs: number }) {
  const updatedMs = new Date(row.updated_at).getTime();
  const stale = !Number.isFinite(updatedMs) || nowMs - updatedMs > STALE_MS;
  const activeWindows = row.windows.filter(
    (window) => new Date(window.resets_at).getTime() > nowMs
  );
  const min = minRemaining(activeWindows);
  // 행 상태 점 = 가장 많이 쓴(최악) 창의 사용률.
  const worstUsed = min === null ? null : (100 - min) / 100;

  return (
    <div className={`mc-card flex items-center gap-4 px-4 py-3 ${stale ? "opacity-50" : ""}`}>
      <StatusDot used={worstUsed} size={9} />
      <div className="min-w-0 w-44 shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <div className="text-[13px] font-semibold text-text-primary truncate">
            {row.owner_name ?? row.owner_email}
          </div>
          <span className="num shrink-0 rounded-full border border-hairline px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-text-secondary">
            {row.provider}
          </span>
        </div>
        <div className="flex items-center gap-1.5 min-w-0" title={row.account_email}>
          <span className="text-[11px] text-text-tertiary truncate">{row.account_email}</span>
          {row.plan_type ? (
            <span className="num shrink-0 text-[10.5px] font-medium text-text-secondary">
              {row.plan_type}
            </span>
          ) : null}
        </div>
      </div>
      <div
        className="flex-1 grid gap-4 min-w-0"
        style={{
          gridTemplateColumns: `repeat(${Math.max(1, row.windows.length)}, minmax(0, 1fr))`,
        }}
      >
        {row.windows.map((w, i) => {
          // 표기 숫자·게이지 채움은 사용률, 색은 잔여 기준 (트레이·패널과 통일).
          const used = usedPct(w.utilization);
          const resetMs = new Date(w.resets_at).getTime();
          const resetOk = Number.isFinite(resetMs) && resetMs > nowMs;
          return (
            <div key={`${w.kind}:${w.scope_model ?? i}`} className="min-w-0">
              <div className="flex items-center justify-between mb-1 gap-2">
                <span className="text-[10.5px] font-semibold text-text-secondary">
                  {windowShortLabel(w)}
                </span>
                <span
                  className={`num text-[11.5px] ${resetOk ? quotaSignalClass(used / 100) : "text-text-faint"}`}
                >
                  {resetOk ? `${used}%` : "—"}
                </span>
              </div>
              <QuotaSegBar
                value={resetOk ? used / 100 : null}
                label={`${windowShortLabel(w)} 사용률`}
              />
              {/* 창(5h/7d/Fable)별 초기화 시각을 각자 표기 (2026-07-14 요청). */}
              <div
                className="num text-[10.5px] text-text-tertiary mt-1 whitespace-nowrap"
                title={resetOk ? `${formatRelativeTimeKo(resetMs - nowMs)} 후 초기화` : undefined}
              >
                {resetOk ? `리셋 ${formatResetKo(resetMs)}` : "갱신 대기"}
              </div>
            </div>
          );
        })}
      </div>
      <div className="text-right shrink-0 w-20">
        <div className="num text-[10.5px] text-text-tertiary">
          {Number.isFinite(updatedMs) ? `${formatRelativeTimeKo(nowMs - updatedMs)} 전 갱신` : "—"}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ text }: { readonly text: string }) {
  return (
    <div className="grid place-items-center rounded-[10px] border border-hairline bg-surface-2 px-6 py-14 text-center">
      <p className="text-[13px] text-text-secondary">{text}</p>
    </div>
  );
}
