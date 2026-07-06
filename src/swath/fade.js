import * as Cesium from 'cesium';

const { Color } = Cesium;

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * 条带颜色：白 → 灰 → 透明（30 天周期）
 * 使用 smoothstep 避免白/灰硬切；略降 alpha 减轻多层叠加闪烁
 */
export function swathColorForAge(ageDays, fadeConfig) {
  const { cycleDays, freshDays = 1 } = fadeConfig;

  if (ageDays < 0 || ageDays >= cycleDays) {
    return Color.TRANSPARENT;
  }

  const fadeSpan = cycleDays - freshDays;
  const t = fadeSpan > 0 ? (ageDays - freshDays) / fadeSpan : 0;
  const fadeT = Math.max(0, Math.min(1, t));

  const whiteBlend = 1 - smoothstep(freshDays, freshDays + 0.75, ageDays);
  const g = 0.55 + (1 - fadeT) * 0.4;
  const alpha = 0.78 - fadeT * 0.68;

  const r = 1 * whiteBlend + g * (1 - whiteBlend);
  const gv = 1 * whiteBlend + g * (1 - whiteBlend);
  const b = 1 * whiteBlend + g * (1 - whiteBlend);

  return new Color(r, gv, b, alpha);
}

/** 褪色重建分桶：按整天，避免高频 destroy/recreate */
export function fadeColorBucket(ageDays, fadeConfig) {
  const { cycleDays } = fadeConfig;
  if (ageDays < 0 || ageDays >= cycleDays) return -1;
  return Math.floor(ageDays);
}

export function secondsToDays(seconds) {
  return seconds / 86400;
}
