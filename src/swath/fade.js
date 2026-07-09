import * as Cesium from 'cesium';

const { Color } = Cesium;

/** 分段褪色：第 1 天 / 2–15 天 / 15 天以后 */
const FADE_BAND_DAY1 = { gray: 0.95, alpha: 0.9 };
const FADE_BAND_DAY2_15 = { gray: 0.8, alpha: 0.8 };
const FADE_BAND_AFTER_15 = { gray: 0.7, alpha: 0.6 };

function styleForAge(ageDays) {
  if (ageDays < 1) return FADE_BAND_DAY1;
  if (ageDays < 15) return FADE_BAND_DAY2_15;
  return FADE_BAND_AFTER_15;
}

function colorFromStyle({ gray, alpha }) {
  return new Color(gray, gray, gray, alpha);
}

/**
 * 条带颜色（分段常数，无连续渐变）
 * - 第 1 天：灰 0.95 / α 0.9
 * - 第 2–15 天：灰 0.8 / α 0.8
 * - 第 15 天起：灰 0.7 / α 0.6
 * hideAfterCycle=true 时 age>=cycleDays 完全隐藏；false 时 15 天后保持最淡档
 */
export function swathColorForAge(ageDays, fadeConfig) {
  const { cycleDays = 30, hideAfterCycle = true } = fadeConfig;

  if (ageDays < 0) {
    return Color.TRANSPARENT;
  }

  if (hideAfterCycle && ageDays >= cycleDays) {
    return Color.TRANSPARENT;
  }

  return colorFromStyle(styleForAge(ageDays));
}

/** 褪色重建分桶：三档 + 隐藏 */
export function fadeColorBucket(ageDays, fadeConfig) {
  const { cycleDays = 30, hideAfterCycle = true } = fadeConfig;
  if (ageDays < 0) return -1;
  if (hideAfterCycle && ageDays >= cycleDays) return -1;
  if (ageDays < 1) return 0;
  if (ageDays < 15) return 1;
  return 2;
}

export function shouldHideSwath(ageDays, fadeConfig) {
  const { cycleDays = 30, hideAfterCycle = true } = fadeConfig;
  return hideAfterCycle && ageDays >= cycleDays;
}

export function secondsToDays(seconds) {
  return seconds / 86400;
}
