import * as Cesium from 'cesium';

const { Color } = Cesium;

const STYLE_DAY1_10 = { gray: 0.95, alpha: 0.9 };
const STYLE_DAY10_20 = { gray: 0.95, alpha: 0.8 };
const STYLE_AFTER_20 = { gray: 0.7, alpha: 0.6 };

function colorFromStyle({ gray, alpha }) {
  return new Color(gray, gray, gray, alpha);
}

/**
 * 条带颜色（分段常数）
 *
 * hideAfterCycle=false：
 *   1–10 天 灰 0.95 / α 0.9；10 天后 灰 0.95 / α 0.8（永久保留）
 *
 * hideAfterCycle=true：
 *   1–10 天 灰 0.95 / α 0.9；10–20 天 灰 0.95 / α 0.8；
 *   20 天后 灰 0.7 / α 0.6；≥30 天隐藏
 */
export function swathColorForAge(ageDays, fadeConfig) {
  const { cycleDays = 30, hideAfterCycle = true } = fadeConfig;

  if (ageDays < 0) {
    return Color.TRANSPARENT;
  }

  if (hideAfterCycle && ageDays >= cycleDays) {
    return Color.TRANSPARENT;
  }

  if (ageDays < 10) {
    return colorFromStyle(STYLE_DAY1_10);
  }

  if (!hideAfterCycle) {
    return colorFromStyle(STYLE_DAY10_20);
  }

  if (ageDays < 20) {
    return colorFromStyle(STYLE_DAY10_20);
  }

  return colorFromStyle(STYLE_AFTER_20);
}

/** 褪色重建分桶 */
export function fadeColorBucket(ageDays, fadeConfig) {
  const { cycleDays = 30, hideAfterCycle = true } = fadeConfig;
  if (ageDays < 0) return -1;
  if (hideAfterCycle && ageDays >= cycleDays) return -1;
  if (ageDays < 10) return 0;
  if (!hideAfterCycle) return 1;
  if (ageDays < 20) return 1;
  return 2;
}

export function shouldHideSwath(ageDays, fadeConfig) {
  const { cycleDays = 30, hideAfterCycle = true } = fadeConfig;
  return hideAfterCycle && ageDays >= cycleDays;
}

export function secondsToDays(seconds) {
  return seconds / 86400;
}
