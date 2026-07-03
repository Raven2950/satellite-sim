import * as Cesium from 'cesium';
import { formatUtcTime } from '../core/simClock.js';

export class TimeControls {
  constructor(simClock, { onChange }) {
    this.simClock = simClock;
    this.onChange = onChange;

    this.btnLive = document.getElementById('btnLive');
    this.btnPlay = document.getElementById('btnPlay');
    this.btnSpeed1 = document.getElementById('btnSpeed1');
    this.btnSpeed2 = document.getElementById('btnSpeed2');
    this.dateDisplay = document.getElementById('watchDate');
    this.timeDisplay = document.getElementById('watchTime');

    this._bindEvents();
    this.refresh();
  }

  _bindEvents() {
    this.btnLive.addEventListener('click', () => {
      this.simClock.goLive();
      this.onChange();
      this.refresh();
    });

    this.btnPlay.addEventListener('click', () => {
      this.simClock.togglePlay();
      this.onChange();
      this.refresh();
    });

    this.btnSpeed1.addEventListener('click', () => {
      this.simClock.setSpeed1();
      this.onChange();
      this.refresh();
    });

    this.btnSpeed2.addEventListener('click', () => {
      this.simClock.setSpeed2();
      this.onChange();
      this.refresh();
    });
  }

  refresh() {
    const { dateLabel, timeLabel } = formatUtcTime(this.simClock.currentTime);
    this.dateDisplay.textContent = dateLabel;
    this.timeDisplay.textContent = timeLabel;

    this.btnLive.classList.toggle('active', this.simClock.live);
    this.btnPlay.classList.toggle('active', this.simClock.playing);
    this.btnPlay.innerHTML = this.simClock.playing
      ? '<svg class="wf-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4"/></svg>'
      : '<svg class="wf-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    this.btnPlay.setAttribute(
      'aria-label',
      this.simClock.playing ? '暂停' : '播放',
    );
    this.btnSpeed1.classList.toggle(
      'active',
      this.simClock.activeSpeed === 'speed1',
    );
    this.btnSpeed2.classList.toggle(
      'active',
      this.simClock.activeSpeed === 'speed2',
    );
  }
}
