import { describe, it, expect } from "vitest";
import {
  pctDiff,
  priorDaysAverage,
  avgTokensPerActiveDay,
  tickY,
  projectedMinutesToLimit,
} from "./usage-math";

describe("pctDiff", () => {
  it("양/음 증감률", () => {
    expect(pctDiff(150, 100)).toBeCloseTo(0.5);
    expect(pctDiff(50, 100)).toBeCloseTo(-0.5);
    expect(pctDiff(100, 100)).toBe(0);
  });
  it("기준 0 이하면 0 (0 나눗셈/음수 기준 방지)", () => {
    expect(pctDiff(100, 0)).toBe(0);
    expect(pctDiff(0, 0)).toBe(0);
    expect(pctDiff(100, -5)).toBe(0);
  });
});

describe("priorDaysAverage (U2 — 델타 자기참조 교정)", () => {
  it("오늘을 빼고 직전 priorDays(7)일 평균 — range 7d = 오늘 + 직전 7일", () => {
    // 직전 7일 각 100, 오늘 100 → 합계 800. 직전 평균 = (800-100)/7 = 100.
    expect(priorDaysAverage(800, 100, 7)).toBe(100);
  });
  it("오늘이 평균에 포함되던 옛 버그(sum/7)와 달라짐", () => {
    // 옛 공식 sum/7 = 800/7 ≈ 114.3 (오늘 포함 희석). 새 공식은 100.
    expect(priorDaysAverage(800, 100, 7)).not.toBeCloseTo(800 / 7);
  });
  it("분모는 priorDays(7) — /6 off-by-one 이 아님", () => {
    // 7일치(700)를 7로 나눠야 100. /6 이면 ≈116.7 로 과대산정.
    expect(priorDaysAverage(800, 100, 7)).toBeCloseTo(100);
    expect(priorDaysAverage(800, 100, 7)).not.toBeCloseTo(700 / 6);
  });
  it("today가 합계보다 크면 0 으로 클램프", () => {
    expect(priorDaysAverage(100, 150, 7)).toBe(0);
  });
  it("priorDays<=0 이면 0 (0 나눗셈 방지)", () => {
    expect(priorDaysAverage(500, 100, 0)).toBe(0);
  });
});

describe("avgTokensPerActiveDay (U4 — 윈도우 정합)", () => {
  it("토큰 / 활동일", () => {
    expect(avgTokensPerActiveDay(1000, 4)).toBe(250);
  });
  it("활동일 0 이면 1 로 보정 (토큰 0 → 0)", () => {
    expect(avgTokensPerActiveDay(0, 0)).toBe(0);
    expect(avgTokensPerActiveDay(500, 0)).toBe(500);
  });
});

describe("projectedMinutesToLimit (F1 — 5h 한도 도달 예상)", () => {
  it("선형 페이스 투영", () => {
    expect(projectedMinutesToLimit(50, 60)).toBe(60); // 60분에 50% → 100%까지 60분 더
    expect(projectedMinutesToLimit(25, 60)).toBe(180); // 60분에 25% → 180분 더
    expect(projectedMinutesToLimit(80, 240)).toBe(60); // 4h에 80% → 1h 더 (총 5h)
  });
  it("이미 한도(>=100%)면 0", () => {
    expect(projectedMinutesToLimit(100, 120)).toBe(0);
    expect(projectedMinutesToLimit(130, 120)).toBe(0);
  });
  it("사용 없음/경과 0 이면 투영 불가(null)", () => {
    expect(projectedMinutesToLimit(0, 60)).toBeNull();
    expect(projectedMinutesToLimit(-5, 60)).toBeNull();
    expect(projectedMinutesToLimit(50, 0)).toBeNull();
  });
});

describe("tickY (U3 — y축 눈금 좌표 역전 교정)", () => {
  const padTop = 10;
  const innerH = 200;
  const maxVal = 100;
  it("최대값 tick 은 차트 top(padTop)에 위치", () => {
    expect(tickY(maxVal, maxVal, padTop, innerH)).toBe(padTop);
  });
  it("0 은 바닥(padTop+innerH)", () => {
    expect(tickY(0, maxVal, padTop, innerH)).toBe(padTop + innerH);
  });
  it("절반/4분위 값은 값 비례 위치", () => {
    expect(tickY(50, maxVal, padTop, innerH)).toBe(padTop + innerH * 0.5);
    expect(tickY(75, maxVal, padTop, innerH)).toBe(padTop + innerH * 0.25);
  });
  it("옛 버그(인덱스 (i+1)/5)와 달리 최대값이 top 에서 어긋나지 않음", () => {
    // 옛 공식: 최대값 라벨이 padTop+innerH*0.2 = 50 에 그려져 막대 top(=10)과 어긋났음.
    expect(tickY(maxVal, maxVal, padTop, innerH)).not.toBe(padTop + (innerH * 1) / 5);
  });
  it("maxVal 0 이면 padTop, 값이 maxVal 초과 시 클램프", () => {
    expect(tickY(50, 0, padTop, innerH)).toBe(padTop);
    expect(tickY(150, maxVal, padTop, innerH)).toBe(padTop);
  });
});
