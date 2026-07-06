import * as Cesium from 'cesium';
import { SIMULATION, ORBIT_EPOCH_ISO } from '../config/satellite.js';

const { JulianDate } = Cesium;

const MONTHS = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
];

/** 格式化为 Wayfinder 风格：本机时区日期 + HH:mm:ss */
export function formatLocalTime(julianDate) {
  const d = JulianDate.toDate(julianDate);
  const timeLabel = [
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
  ]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
  const mon = MONTHS[d.getMonth()];
  const day = String(d.getDate()).padStart(2, '0');
  const y = d.getFullYear();
  return {
    dateLabel: `${mon} ${day} ${y}`,
    timeLabel,
    shortDate: `${mon} ${day}`,
    timelineLabel: timeLabel,
  };
}

/** @deprecated 使用 formatLocalTime */
export function formatUtcTime(julianDate) {
  return formatLocalTime(julianDate);
}

export function formatTimezoneBadge() {
  const offsetMin = -new Date().getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (m === 0) return `UTC${sign}${h}`;
  return `UTC${sign}${h}:${String(m).padStart(2, '0')}`;
}

export function formatTimelineTime(julianDate) {
  return formatLocalTime(julianDate).timelineLabel;
}

export function getOrbitEpoch() {
  return JulianDate.fromIso8601(ORBIT_EPOCH_ISO);
}

/**
 * Wayfinder 风格模拟时钟
 * LIVE → 真实 UTC 1×
 * 播放 / 倍速1(600×) / 倍速2(8640×，30天≈5分钟)
 */
export class SimClock {
  constructor(speed1, speed2) {
    this.speed1 = speed1;
    this.speed2 = speed2;

    const now = JulianDate.now();
    this.startTime = JulianDate.addDays(
      now,
      -SIMULATION.historyDays,
      new JulianDate(),
    );
    this.stopTime = JulianDate.addDays(
      now,
      SIMULATION.futureDays,
      new JulianDate(),
    );
    this.currentTime = JulianDate.clone(now, new JulianDate());

    this.live = true;
    this.playing = true;
    this.multiplier = 1;
    this.activeSpeed = 'live';
    this._lastSpeed = 'speed1';
    this._scratch = new JulianDate();
  }

  clamp(time) {
    if (JulianDate.lessThan(time, this.startTime)) {
      return JulianDate.clone(this.startTime, this._scratch);
    }
    if (JulianDate.greaterThan(time, this.stopTime)) {
      return JulianDate.clone(this.stopTime, this._scratch);
    }
    return JulianDate.clone(time, this._scratch);
  }

  tick(wallDeltaSec) {
    if (this.live) {
      this.currentTime = JulianDate.clone(JulianDate.now(), this.currentTime);
      return;
    }

    if (!this.playing || wallDeltaSec <= 0) {
      return;
    }

    JulianDate.addSeconds(
      this.currentTime,
      wallDeltaSec * this.multiplier,
      this.currentTime,
    );
    this.currentTime = this.clamp(this.currentTime);
  }

  goLive() {
    this.live = true;
    this.playing = true;
    this.multiplier = 1;
    this.activeSpeed = 'live';
    this.currentTime = JulianDate.clone(JulianDate.now(), this.currentTime);
  }

  togglePlay() {
    if (this.live) {
      this.live = false;
      this.playing = true;
      this.multiplier = this.speed1;
      this.activeSpeed = 'speed1';
      this._lastSpeed = 'speed1';
      return;
    }

    if (this.playing) {
      this.playing = false;
      this.activeSpeed = 'paused';
      return;
    }

    this.playing = true;
    if (this.activeSpeed === 'paused') {
      this.activeSpeed = this._lastSpeed;
      this.multiplier =
        this._lastSpeed === 'speed2' ? this.speed2 : this.speed1;
    }
  }

  setSpeed1() {
    this.live = false;
    this.playing = true;
    this.multiplier = this.speed1;
    this.activeSpeed = 'speed1';
    this._lastSpeed = 'speed1';
  }

  setSpeed2() {
    this.live = false;
    this.playing = true;
    this.multiplier = this.speed2;
    this.activeSpeed = 'speed2';
    this._lastSpeed = 'speed2';
  }

  scrubToFraction(fraction) {
    this.live = false;
    this.playing = false;
    this.activeSpeed = 'paused';

    const span = JulianDate.secondsDifference(this.stopTime, this.startTime);
    const sec = span * Math.max(0, Math.min(1, fraction));
    JulianDate.addSeconds(this.startTime, sec, this.currentTime);
  }

  /** 在局部时间轴窗口内 scrub（Wayfinder 风格） */
  scrubToWindowFraction(windowStart, windowSpanSec, fraction) {
    this.live = false;
    this.playing = false;
    this.activeSpeed = 'paused';

    const sec = windowSpanSec * Math.max(0, Math.min(1, fraction));
    JulianDate.addSeconds(windowStart, sec, this.currentTime);
    this.currentTime = this.clamp(this.currentTime);
  }

  getFraction() {
    const span = JulianDate.secondsDifference(this.stopTime, this.startTime);
    if (span <= 0) return 0;
    const cur = JulianDate.secondsDifference(this.currentTime, this.startTime);
    return Math.max(0, Math.min(1, cur / span));
  }

  syncToViewer(viewer) {
    viewer.clock.startTime = JulianDate.clone(this.startTime, new JulianDate());
    viewer.clock.stopTime = JulianDate.clone(this.stopTime, new JulianDate());
    viewer.clock.currentTime = JulianDate.clone(
      this.currentTime,
      new JulianDate(),
    );
    viewer.clock.shouldAnimate = false;
  }
}
