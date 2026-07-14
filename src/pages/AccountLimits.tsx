import { useState } from "react";
import { QuotaSegBar } from "@/components/ui/QuotaSegBar";
import { Segmented } from "@/components/ui/Segmented";
import { StatusDot } from "@/components/ui/StatusDot";
import { quotaSignalClass } from "@/components/ui/quotaSignal";
import { useClaudeAccountLimits } from "@/hooks/useRateLimits";
import {
  formatRelativeTimeKo,
  formatResetKo,
  minRemaining,
  sortByRemainingDesc,
  usedPct,
  windowShortLabel,
  type SortKind,
} from "@/lib/limits";
import type { ClaudeAccountLimitRow } from "@/types/models";

const SORT_OPTIONS: { value: SortKind; label: string }[] = [
  { value: "weekly_scoped", label: "Fable" },
  { value: "weekly_all", label: "주간" },
  { value: "session", label: "5시간" },
];

/// 마지막 갱신 30분 초과 → 흐리게 (죽은 데이터 오인 방지, 스펙 §4.4).
const STALE_MS = 30 * 60_000;

/// 사이드바 "계정 한도" — 계정별 Claude 잔여 한도/리셋 현황. 쉐어 요청 판단용.
export default function AccountLimits() {
  const { data: rows = [], isLoading, error } = useClaudeAccountLimits();
  const [sortKind, setSortKind] = useState<SortKind>("weekly_scoped");
  const nowMs = Date.now();
  const sorted = sortByRemainingDesc(rows, (r) => r.windows, sortKind);

  return (
    <div className="px-7 pt-5 pb-8">
      <header className="flex items-center justify-between mb-5 gap-3">
        <div>
          <h1 className="text-[18px] font-bold text-text-primary">계정 한도</h1>
          <p className="text-[12px] text-text-tertiary mt-1">
            계정별 Claude 한도 사용률 — 여유 있는 계정에 쉐어를 요청하세요. 여유 많은 순 정렬.
          </p>
        </div>
        <Segmented
          value={sortKind}
          onChange={setSortKind}
          options={SORT_OPTIONS}
          ariaLabel="정렬 기준 한도 창"
        />
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
            <AccountRow key={row.account_uuid} row={row} nowMs={nowMs} />
          ))}
        </div>
      )}
    </div>
  );
}

function AccountRow({
  row,
  nowMs,
}: {
  readonly row: ClaudeAccountLimitRow;
  readonly nowMs: number;
}) {
  const updatedMs = new Date(row.updated_at).getTime();
  const stale = !Number.isFinite(updatedMs) || nowMs - updatedMs > STALE_MS;
  const min = minRemaining(row.windows);

  return (
    <div
      className={`mc-card flex items-center gap-4 px-4 py-3 ${stale ? "opacity-50" : ""}`}
    >
      <StatusDot remaining={min === null ? null : min / 100} size={9} />
      <div className="min-w-0 w-44 shrink-0">
        <div className="text-[13px] font-semibold text-text-primary truncate">
          {row.owner_name ?? row.owner_email}
        </div>
        <div className="text-[11px] text-text-tertiary truncate" title={row.account_email}>
          {row.account_email}
        </div>
      </div>
      <div className="flex-1 grid grid-cols-3 gap-4 min-w-0">
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
                <span className={`num text-[11.5px] ${quotaSignalClass((100 - used) / 100)}`}>
                  {used}%
                </span>
              </div>
              <QuotaSegBar
                value={used / 100}
                segments={8}
                label={`${windowShortLabel(w)} 사용률`}
              />
              {/* 창(5h/7d/Fable)별 초기화 시각을 각자 표기 (2026-07-14 요청). */}
              <div
                className="num text-[9.5px] text-text-faint mt-1 whitespace-nowrap"
                title={resetOk ? `${formatRelativeTimeKo(resetMs - nowMs)} 후 초기화` : undefined}
              >
                {resetOk ? `리셋 ${formatResetKo(resetMs)}` : "갱신 대기"}
              </div>
            </div>
          );
        })}
      </div>
      <div className="text-right shrink-0 w-20">
        <div className="text-[10px] text-text-faint">
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
