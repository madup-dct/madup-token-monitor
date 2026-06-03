// 사용량 대시보드의 순수 수치 로직. 컴포넌트에서 분리해 회귀 테스트(usage-math.test.ts)로 고정.
// 여기 함수들은 부수효과 없는 pure function 이어야 한다 (테스트 용이성 + 차트/KPI 정합성 보장).

/// 증감률. 기준(b)이 0 이하면 0 (0 나눗셈/음수 기준 방지).
export function pctDiff(a: number, b: number): number {
  if (b <= 0) return 0;
  return (a - b) / b;
}

/// "오늘"을 제외한 직전 priorDays 일의 일평균.
/// windowSumTokens 는 오늘 + 직전 priorDays 일을 포함하는 합계.
/// range_bounds("7d") = midnight(today-7)~now 라 합계 창은 "오늘 + 직전 7일"(8개 날짜 버킷).
/// 따라서 priorDays=7 (오늘 제외 7일). 평균에 오늘을 포함하면 자기참조로 희석되므로 today 를 빼고 priorDays 로 나눈다.
export function priorDaysAverage(
  windowSumTokens: number,
  todayTokens: number,
  priorDays = 7,
): number {
  if (priorDays <= 0) return 0;
  const priorSum = Math.max(0, windowSumTokens - todayTokens);
  return priorSum / priorDays;
}

/// 활동일당 평균 토큰. 분자(periodTokens)와 분모(activeDays)는 같은 기간 창이어야 의미가 맞다.
/// activeDays 가 0 이면 1 로 보정 (토큰도 0 이므로 결과 0).
export function avgTokensPerActiveDay(periodTokens: number, activeDays: number): number {
  return periodTokens / Math.max(1, activeDays);
}

/// 현재 5h 윈도우의 평균 페이스로 한도(100%) 도달까지 남은 분.
/// utilizationPct = 현재 사용률(%), elapsedMin = 윈도우 시작 후 경과 분.
/// 가정: 사용률이 윈도우 시작부터 선형 증가 (rate = U/elapsed %/min) → 남은 (100-U)% / rate.
/// 반환: 분(number). 사용 없음(U<=0)이거나 경과 0(elapsedMin<=0)이면 null(투영 불가). 이미 한도(U>=100)면 0.
export function projectedMinutesToLimit(
  utilizationPct: number,
  elapsedMin: number,
): number | null {
  if (utilizationPct >= 100) return 0;
  if (utilizationPct <= 0 || elapsedMin <= 0) return null;
  return (elapsedMin * (100 - utilizationPct)) / utilizationPct;
}

/// 차트 y 좌표 — tick 값(tickValue)을 값 스케일에 맞는 픽셀 y 로 변환.
/// 최대값(maxVal)은 차트 top(=padTop), 0 은 바닥(=padTop+innerH).
/// 기존 버그: tick 들을 (i+1)/5 같은 인덱스 비율로 그려 라벨이 실제 막대/라인 높이와 어긋났음.
/// 값 기반(1 - tickValue/maxVal)으로 그려야 라벨·격자·데이터가 정합한다.
export function tickY(
  tickValue: number,
  maxVal: number,
  padTop: number,
  innerH: number,
): number {
  if (maxVal <= 0) return padTop;
  const frac = Math.min(1, Math.max(0, 1 - tickValue / maxVal));
  return padTop + innerH * frac;
}
