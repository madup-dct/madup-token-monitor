import { useMemo, useState } from "react";
import { useCurrentRole, roleAtLeast } from "@/hooks/useRole";
import {
  useDirectory,
  useCompanyTopMcp,
  useCompanyTopPlugins,
  useEntityUsers,
  useCompanyUsageByUser,
  useCompanyHourlyByUser,
} from "@/hooks/useUsage";
import { CarouselCard } from "@/components/dashboard/CarouselCard";
import { RankBarList } from "@/components/ui/RankBarList";
import { Segmented } from "@/components/ui/Segmented";
import { MultiLineChart } from "@/components/charts/MultiLineChart";
import { Select } from "@/components/ui/Select";
import { UserFilterTable } from "@/components/team/UserFilterTable";
import { UserListModal } from "@/components/team/UserListModal";
import { formatTokensCompact } from "@/lib/format";
import { usePersistentState } from "@/lib/usePersistentState";

const RANGE_OPTIONS = [
  { value: "7", label: "최근 7일" },
  { value: "30", label: "최근 30일" },
  { value: "90", label: "최근 90일" },
];

type EntityModal = { kind: "mcp" | "plugin"; entity: string; label: string };

type Gran = "hourly" | "daily" | "weekly" | "monthly";
const GRAN_OPTIONS = [
  { value: "hourly", label: "시간별" },
  { value: "daily", label: "일자별" },
  { value: "weekly", label: "주별" },
  { value: "monthly", label: "월별" },
];

function localDateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function weekStartKey(ts: number): string {
  const d = new Date(ts);
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  d.setHours(0, 0, 0, 0);
  return localDateKey(d.getTime());
}
function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function localHourKey(ts: number): string {
  const d = new Date(ts);
  return `${localDateKey(ts)} ${String(d.getHours()).padStart(2, "0")}:00`;
}
function weekLabel(weekStart: string): string {
  const d = new Date(weekStart + "T00:00:00");
  return `${d.getMonth() + 1}/${d.getDate()}~`;
}
function monthLabel(mk: string): string {
  const [y, m] = mk.split("-");
  return `${y!.slice(2)}년 ${parseInt(m!, 10)}월`;
}

interface SeriesOut {
  xLabels: string[];
  series: { label: string; color: string; points: number[] }[];
}

/// granularity 별로 사원×버킷 데이터를 모아 per-bucket 평균/최대/최소(사원 기준) 시리즈 생성.
function buildUsageChart(
  gran: Gran,
  dailyRows: { user_id: string; date: string; total_tokens: number }[],
  hourlyRows: { user_id: string; hour_utc: string; total_tokens: number }[],
): SeriesOut {
  let entries: { user: string; key: string; tokens: number }[];
  let orderedKeys: string[] = [];
  let labelOf: (k: string) => string;

  if (gran === "hourly") {
    entries = hourlyRows.map((r) => ({
      user: r.user_id,
      key: localHourKey(new Date(r.hour_utc).getTime()),
      tokens: r.total_tokens,
    }));
    const base = new Date();
    base.setMinutes(0, 0, 0);
    for (let i = 23; i >= 0; i--) orderedKeys.push(localHourKey(base.getTime() - i * 3600_000));
    labelOf = (k) => `${k.slice(11, 13)}시`;
  } else {
    const keyFn = gran === "weekly" ? weekStartKey : gran === "monthly" ? monthKey : localDateKey;
    entries = dailyRows.map((r) => ({
      user: r.user_id,
      key: keyFn(new Date(r.date + "T00:00:00").getTime()),
      tokens: r.total_tokens,
    }));
    if (gran === "daily") {
      const t = new Date();
      t.setHours(0, 0, 0, 0);
      for (let i = 29; i >= 0; i--) {
        const d = new Date(t);
        d.setDate(t.getDate() - i);
        orderedKeys.push(localDateKey(d.getTime()));
      }
      labelOf = (k) => k.slice(5);
    } else if (gran === "weekly") {
      const ws = weekStartKey(new Date().getTime());
      for (let i = 11; i >= 0; i--) {
        const d = new Date(ws + "T00:00:00");
        d.setDate(d.getDate() - i * 7);
        orderedKeys.push(localDateKey(d.getTime()));
      }
      labelOf = (k) => weekLabel(k);
    } else {
      const t = new Date();
      for (let i = 11; i >= 0; i--) {
        const d = new Date(t.getFullYear(), t.getMonth() - i, 1);
        orderedKeys.push(monthKey(d.getTime()));
      }
      labelOf = (k) => monthLabel(k);
    }
  }

  // bucket → (user → tokens 합산)
  const byBucket = new Map<string, Map<string, number>>();
  for (const e of entries) {
    let m = byBucket.get(e.key);
    if (!m) {
      m = new Map();
      byBucket.set(e.key, m);
    }
    m.set(e.user, (m.get(e.user) ?? 0) + e.tokens);
  }
  const avg: number[] = [];
  const max: number[] = [];
  const min: number[] = [];
  for (const k of orderedKeys) {
    const m = byBucket.get(k);
    const vals = m ? [...m.values()].filter((v) => v > 0) : [];
    if (vals.length === 0) {
      avg.push(0);
      max.push(0);
      min.push(0);
    } else {
      const s = vals.reduce((a, b) => a + b, 0);
      avg.push(s / vals.length);
      max.push(Math.max(...vals));
      min.push(Math.min(...vals));
    }
  }
  return {
    xLabels: orderedKeys.map(labelOf),
    series: [
      { label: "평균", color: "var(--color-azure)", points: avg },
      { label: "최대", color: "var(--color-lime)", points: max },
      { label: "최소", color: "var(--color-amber)", points: min },
    ],
  };
}

/// 매니저 전용 사용량 분석 — 사원 토큰 추이(평균/최대/최소) + 전사 유저 테이블 + MCP/플러그인별 사용자.
export default function AdminAnalytics() {
  const role = useCurrentRole();
  const [days, setDays] = usePersistentState(
    "madup-token-monitor:view:admin:days",
    30,
  );
  const [gran, setGran] = usePersistentState<Gran>(
    "madup-token-monitor:view:admin:gran",
    "daily",
  );
  const [modal, setModal] = useState<EntityModal | null>(null);

  const dir = useDirectory(days);
  const mcp = useCompanyTopMcp(days);
  const plugins = useCompanyTopPlugins(days);
  const entityUsers = useEntityUsers(modal?.kind ?? null, modal?.entity ?? null, days);
  const usageByUser = useCompanyUsageByUser(365);
  const hourlyByUser = useCompanyHourlyByUser(48, gran === "hourly");

  // 사원 토큰 추이(평균/최대/최소) — granularity 별 per-bucket 통계.
  const chart = useMemo(
    () => buildUsageChart(gran, usageByUser.data ?? [], hourlyByUser.data ?? []),
    [gran, usageByUser.data, hourlyByUser.data],
  );

  const distribution = useMemo(
    () =>
      (dir.data ?? [])
        .filter((r) => r.total_tokens > 0)
        .slice(0, 12)
        .map((r) => ({ label: r.display_name, value: r.total_tokens })),
    [dir.data],
  );

  if (!roleAtLeast(role, "manager")) {
    return (
      <div className="px-7 pt-5 pb-8">
        <div className="mc-card p-8 text-center text-text-tertiary text-[13px]">
          사용량 분석은 매니저 이상만 접근할 수 있습니다.
        </div>
      </div>
    );
  }

  return (
    <div className="px-7 pt-6 pb-8">
      {/* Head */}
      <div className="flex items-center justify-between gap-4 mb-5 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-[22px] font-bold tracking-[-0.01em] text-text-primary">사용량 분석</h1>
          <p className="text-[12px] text-text-tertiary mt-1">
            사원 토큰 추이 · 전사 유저 · MCP/플러그인 사용자 (매니저 전용)
          </p>
        </div>
        <Select
          value={String(days)}
          onChange={(v) => setDays(Number(v))}
          options={RANGE_OPTIONS}
          ariaLabel="기간 선택"
        />
      </div>

      {dir.error ? (
        <div className="mc-card p-4 text-[12px] text-coral mb-4">
          RPC 실패: {String(dir.error.message)} — 마이그레이션(0015) 적용 여부 확인.
        </div>
      ) : null}

      {/* 사원 토큰 추이 — 평균/최대/최소 라인 (시간별/일별/주별/월별 토글) */}
      <section className="mc-card mb-4">
        <header className="flex items-center justify-between mb-3 gap-3 flex-wrap">
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] font-semibold text-text-primary">사원 토큰 사용량 추이</span>
            <span className="text-[11px] text-text-tertiary">사원별 평균 · 최대 · 최소</span>
          </div>
          <Segmented
            value={gran}
            onChange={(v) => setGran(v as Gran)}
            options={GRAN_OPTIONS}
            ariaLabel="단위 선택"
          />
        </header>
        {usageByUser.error || hourlyByUser.error ? (
          <p className="text-[12px] text-coral py-6 text-center">
            RPC 실패: {String((usageByUser.error ?? hourlyByUser.error)?.message)} — 마이그레이션(0016) 적용 확인.
          </p>
        ) : (
          <div
            className="rounded-[10px] border border-hairline p-4"
            style={{ background: "var(--color-surface-2)" }}
          >
            <MultiLineChart
              series={chart.series}
              xLabels={chart.xLabels}
              formatValue={(v) => formatTokensCompact(v)}
            />
          </div>
        )}
      </section>

      {/* 유저 테이블 (col-8) + 사원별 분포 (col-4) */}
      <div className="grid grid-cols-12 gap-4 mb-4">
        <div className="col-span-8">
          <UserFilterTable rows={dir.data ?? []} isLoading={dir.isLoading} error={dir.error ?? null} />
        </div>
        <section className="mc-card col-span-4">
          <header className="mb-3 flex items-baseline justify-between">
            <span className="text-[15px] font-semibold text-text-primary">사원별 토큰 분포</span>
            <span className="text-[11px] text-text-tertiary">상위 12명</span>
          </header>
          <RankBarList
            items={distribution}
            formatValue={(v) => formatTokensCompact(v)}
            maxRows={12}
            emptyMessage={dir.isLoading ? "로딩 중…" : "데이터 없음"}
          />
        </section>
      </div>

      {/* 엔터티별 사용자 (행 클릭 → 사용자 리스트 모달) */}
      <CarouselCard
        persistKey="madup-token-monitor:view:admin:carousel"
        className="col-span-12"
        height={360}
        faces={[
          {
            key: "mcp",
            title: "MCP 사용량",
            subtitle: "행 클릭 → 사용자",
            node: (
              <div className="h-full pr-1">
                <RankBarList
                  items={(mcp.data ?? []).map((m) => ({ label: m.mcp_server, value: m.count }))}
                  formatValue={(v) => v.toLocaleString("ko-KR")}
                  maxRows={12}
                  emptyMessage={mcp.isLoading ? "로딩 중…" : "MCP 기록 없음"}
                  onItemClick={(_it, idx) => {
                    const row = (mcp.data ?? [])[idx];
                    if (row) setModal({ kind: "mcp", entity: row.mcp_server, label: row.mcp_server });
                  }}
                />
              </div>
            ),
          },
          {
            key: "plugin",
            title: "플러그인 사용량",
            subtitle: "행 클릭 → 사용자",
            node: (
              <div className="h-full pr-1">
                <RankBarList
                  items={(plugins.data ?? []).map((p) => ({ label: p.plugin_id, value: p.count }))}
                  formatValue={(v) => v.toLocaleString("ko-KR")}
                  maxRows={12}
                  emptyMessage={plugins.isLoading ? "로딩 중…" : "플러그인 기록 없음"}
                  onItemClick={(_it, idx) => {
                    const row = (plugins.data ?? [])[idx];
                    if (row) setModal({ kind: "plugin", entity: row.plugin_id, label: row.plugin_id });
                  }}
                />
              </div>
            ),
          },
        ]}
      />

      <UserListModal
        open={!!modal}
        onClose={() => setModal(null)}
        title={modal ? `${modal.label} · 사용자` : ""}
        valueLabel="사용 수"
        rows={entityUsers.data ?? []}
        formatValue={(v) => v.toLocaleString("ko-KR")}
        isLoading={entityUsers.isLoading}
        error={entityUsers.error ?? null}
      />
    </div>
  );
}
