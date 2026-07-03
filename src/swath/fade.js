import * as Cesium from 'cesium';

const { Color } = Cesium;

/**
 * 条带颜色：白 → 灰 → 透明（30 天周期）
 * 高对比度，覆盖在地球贴图之上清晰可见
 */
export function swathColorForAge(ageDays, fadeConfig) {
  const { cycleDays, freshDays = 1 } = fadeConfig;

  if (ageDays < 0 || ageDays >= cycleDays) {
    return Color.TRANSPARENT;
  }
  if (ageDays <= freshDays) {
    return new Color(1, 1, 1, 0.96);
  }

  const t = (ageDays - freshDays) / (cycleDays - freshDays);
  const g = 0.55 + (1 - t) * 0.4;
  return new Color(g, g, g, 0.92 - t * 0.75);
}

export function secondsToDays(seconds) {
  return seconds / 86400;
}
