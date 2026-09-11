import { describe, expect, it } from "vitest";
import { pickQuotaSignal } from "@/components/ui/quotaSignal";
import {
  formatResetKo,
  isAccountWindowFresh,
  isLimitObservationFresh,
  minRemaining,
  remainingPct,
  sortByRemainingDesc,
  usedPct,
  windowLabel,
  windowOfKind,
  windowShortLabel,
} from "@/lib/limits";
import type { AccountLimitRow, LimitWindow } from "@/types/models";

function w(kind: string, utilization: number, scope_model: string | null = null): LimitWindow {
  return { kind, scope_model, utilization, resets_at: "2026-07-20T08:00:00+00:00" };
}

describe("한도 관측 시각", () => {
  const nowMs = Date.parse("2026-07-19T08:00:00Z");
  const row: AccountLimitRow = {
    provider: "codex",
    account_id: "account",
    account_email: "user@example.com",
    owner_email: "user@example.com",
    owner_name: null,
    plan_type: null,
    windows: [],
    fetched_at: new Date(nowMs).toISOString(),
    updated_at: new Date(nowMs).toISOString(),
  };

  it("30분 경계, 잘못된 시각, 미래 5분 초과를 판정한다", () => {
    expect(isLimitObservationFresh(nowMs - 30 * 60_000, nowMs)).toBe(true);
    expect(isLimitObservationFresh(nowMs - 30 * 60_000 - 1, nowMs)).toBe(false);
    expect(isLimitObservationFresh(Number.NaN, nowMs)).toBe(false);
    expect(isLimitObservationFresh(nowMs + 5 * 60_000 + 1, nowMs)).toBe(false);
  });

  it("새 계정 갱신 시각이 오래된 모델 관측을 새것으로 만들지 않는다", () => {
    const old = { ...w("weekly_scoped", 5), observed_at: nowMs - 31 * 60_000 };
    const recent = { ...w("weekly_scoped", 70), observed_at: nowMs };
    expect(isAccountWindowFresh(row, old, nowMs)).toBe(false);
    expect(isAccountWindowFresh(row, recent, nowMs)).toBe(true);
    expect(isAccountWindowFresh(row, w("weekly_all", 5), nowMs)).toBe(false);
    const rows = [
      { ...row, account_id: "old", windows: [old] },
      { ...row, account_id: "recent", windows: [recent] },
    ];
    expect(
      sortByRemainingDesc(
        rows,
        (r) => r.windows.filter((window) => isAccountWindowFresh(r, window, nowMs)),
        "weekly_scoped"
      ).map((r) => r.account_id)
    ).toEqual(["recent", "old"]);
  });

  it("리셋된 창과 오래된 실제 fetch를 새 업로드 시각으로 표시하지 않는다", () => {
    expect(
      isAccountWindowFresh(
        row,
        {
          ...w("session", 70),
          observed_at: nowMs,
          resets_at: new Date(nowMs).toISOString(),
        },
        nowMs
      )
    ).toBe(false);
    expect(
      isAccountWindowFresh(
        { ...row, provider: "claude", fetched_at: new Date(nowMs - 31 * 60_000).toISOString() },
        w("weekly_all", 5),
        nowMs
      )
    ).toBe(false);
  });
});

describe("pickQuotaSignal (사용률 기준)", () => {
  it("사용률 <40% 초록 / 40~70% 주황 / ≥70% 빨강", () => {
    expect(pickQuotaSignal(0)).toBe("lime");
    expect(pickQuotaSignal(0.39)).toBe("lime");
    expect(pickQuotaSignal(0.4)).toBe("amber");
    expect(pickQuotaSignal(0.69)).toBe("amber");
    expect(pickQuotaSignal(0.7)).toBe("coral");
    expect(pickQuotaSignal(0.92)).toBe("coral");
  });
});

describe("remainingPct", () => {
  it("100 - 사용률, 0~100 클램프, 정수 반올림", () => {
    expect(remainingPct(59)).toBe(41);
    expect(remainingPct(42.5)).toBe(58);
    expect(remainingPct(0)).toBe(100);
    expect(remainingPct(120)).toBe(0);
    expect(remainingPct(-5)).toBe(100);
  });
});

describe("usedPct", () => {
  it("사용률 그대로, 0~100 클램프, 정수 반올림 (표기 숫자용)", () => {
    expect(usedPct(59)).toBe(59);
    expect(usedPct(42.5)).toBe(43);
    expect(usedPct(0)).toBe(0);
    expect(usedPct(120)).toBe(100);
    expect(usedPct(-5)).toBe(0);
  });
});

describe("windowLabel / windowShortLabel", () => {
  it("kind 별 한국어 라벨", () => {
    expect(windowLabel(w("session", 0))).toBe("5시간 한도");
    expect(windowLabel(w("weekly_all", 0))).toBe("주간 한도");
    expect(windowLabel(w("weekly_scoped", 0, "Fable"))).toBe("주간 · Fable");
    expect(windowLabel(w("unknown_kind", 0))).toBe("unknown_kind");
  });
  it("트레이/페이지용 축약 라벨", () => {
    expect(windowShortLabel(w("session", 0))).toBe("5h");
    expect(windowShortLabel(w("weekly_all", 0))).toBe("7d");
    expect(windowShortLabel(w("weekly_scoped", 0, "Fable"))).toBe("F");
  });
});

describe("formatResetKo", () => {
  it("MM/DD HH:mm (로컬 tz)", () => {
    const ms = new Date(2026, 6, 14, 0, 59).getTime(); // 로컬 07/14 00:59
    expect(formatResetKo(ms)).toBe("07/14 00:59");
  });
});

describe("minRemaining / windowOfKind / sortByRemainingDesc", () => {
  const rows = [
    { name: "a", windows: [w("session", 8), w("weekly_scoped", 48, "Fable")] },
    { name: "b", windows: [w("session", 50), w("weekly_scoped", 10, "Fable")] },
    { name: "c", windows: [w("session", 20)] }, // Fable 창 없음 → 뒤로
  ];
  it("최저 잔여", () => {
    expect(minRemaining(rows[0].windows)).toBe(52);
    expect(minRemaining([])).toBeNull();
  });
  it("kind 로 창 찾기", () => {
    expect(windowOfKind(rows[0].windows, "weekly_scoped")?.scope_model).toBe("Fable");
    expect(windowOfKind(rows[2].windows, "weekly_scoped")).toBeNull();
  });
  it("잔여 많은 순 정렬, 창 없는 row 는 마지막", () => {
    const sorted = sortByRemainingDesc(rows, (r) => r.windows, "weekly_scoped");
    expect(sorted.map((r) => r.name)).toEqual(["b", "a", "c"]);
  });
  it("모델별 창이 여러 개면 잔여가 가장 적은 창을 정렬 기준으로 사용", () => {
    const modelRows = [
      { name: "a", windows: [w("weekly_scoped", 10, "Spark"), w("weekly_scoped", 90, "Other")] },
      { name: "b", windows: [w("weekly_scoped", 60, "Spark")] },
    ];
    const sorted = sortByRemainingDesc(modelRows, (row) => row.windows, "weekly_scoped");
    expect(sorted.map((row) => row.name)).toEqual(["b", "a"]);
  });
});
