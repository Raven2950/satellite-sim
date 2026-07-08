import * as Cesium from 'cesium';

const { Color } = Cesium;

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * 条带颜色：白 → 灰 → （可选）透明
 * hideAfterCycle=true 时 age>=cycleDays 完全透明；false 时钳在最淡灰档
 */
export function swathColorForAge(ageDays, fadeConfig) {
  const { cycleDays, freshDays = 1, hideAfterCycle = true } = fadeConfig;

  if (ageDays < 0) {
    return Color.TRANSPARENT;
  }

  if (hideAfterCycle && ageDays >= cycleDays) {
    return Color.TRANSPARENT;
  }

  const effectiveAge = hideAfterCycle
    ? ageDays
    : Math.min(ageDays, cycleDays - 0.001);

  const fadeSpan = cycleDays - freshDays;
  const t = fadeSpan > 0 ? (effectiveAge - freshDays) / fadeSpan : 0;
  const fadeT = Math.max(0, Math.min(1, t));

  const whiteBlend = 1 - smoothstep(freshDays, freshDays + 0.75, effectiveAge);
  const g = 0.55 + (1 - fadeT) * 0.4;
  const alpha = 0.78 - fadeT * 0.68;

  const r = 1 * whiteBlend + g * (1 - whiteBlend);
  const gv = 1 * whiteBlend + g * (1 - whiteBlend);
  const b = 1 * whiteBlend + g * (1 - whiteBlend);

  return new Color(r, gv, b, alpha);
}

/** 褪色重建分桶：按整天，避免高频 destroy/recreate */
export function fadeColorBucket(ageDays, fadeConfig) {
  const { cycleDays, hideAfterCycle = true } = fadeConfig;
  if (ageDays < 0) return -1;
  if (hideAfterCycle && ageDays >= cycleDays) return -1;
  const capped = hideAfterCycle ? ageDays : Math.min(ageDays, cycleDays - 0.001);
  return Math.floor(capped);
}

export function shouldHideSwath(ageDays, fadeConfig) {
  const { cycleDays, hideAfterCycle = true } = fadeConfig;
  return hideAfterCycle && ageDays >= cycleDays;
}

export function secondsToDays(seconds) {
  return seconds / 86400;
}
