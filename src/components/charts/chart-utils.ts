export function niceTickStep(roughStep: number): number {
  if (roughStep <= 0) return 1;
  const exp = Math.floor(Math.log10(roughStep));
  const base = Math.pow(10, exp);
  const multiplier = roughStep / base;
  if (multiplier < 1.5) return base;
  if (multiplier < 2.25) return 2 * base;
  if (multiplier < 3.5) return 2.5 * base;
  if (multiplier < 7.5) return 5 * base;
  return 10 * base;
}
