import { SIMULATION } from '../config/satellite.js';

const PRESET_DAYS = [5, 10, 15, 30, 60];

export class DayJumpControls {
  constructor({ simClock, registry, viewer, onJumpComplete, setJumping }) {
    this.simClock = simClock;
    this.registry = registry;
    this.viewer = viewer;
    this.onJumpComplete = onJumpComplete;
    this.setJumping = setJumping;
    this.loadingEl = document.getElementById('loadingOverlay');
    this.inputEl = document.getElementById('jumpDaysInput');
    this.btnGo = document.getElementById('btnJumpGo');
    this._busy = false;
    this._maxDays = SIMULATION.icrfPreloadDays ?? 400;

    this._bindEvents();
  }

  _bindEvents() {
    for (const btn of document.querySelectorAll('[data-jump-days]')) {
      btn.addEventListener('click', () => {
        const days = Number(btn.getAttribute('data-jump-days'));
        this.jumpToDays(days);
      });
    }

    this.btnGo?.addEventListener('click', () => {
      const days = Number(this.inputEl?.value);
      if (!Number.isFinite(days)) return;
      this.jumpToDays(days);
    });

    this.inputEl?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.btnGo?.click();
      }
    });
  }

  _setLoading(visible, message) {
    if (!this.loadingEl) return;
    if (message) this.loadingEl.textContent = message;
    this.loadingEl.classList.toggle('hidden', !visible);
  }

  async jumpToDays(targetDays) {
    if (this._busy) return;

    const days = Math.max(0, Math.min(this._maxDays, Math.round(targetDays)));
    if (!Number.isFinite(days)) return;

    this._busy = true;
    this.setJumping?.(true);
    this._setLoading(true, `正在快进到第 ${days} 天…`);

    try {
      if (this.simClock.live) {
        this.simClock.markSimAnchor();
        this.simClock.live = false;
        this.simClock.playing = false;
        this.simClock.activeSpeed = 'paused';
      }

      await this.registry.simulateToSimDays(days, this.simClock, {
        onProgress: (fraction) => {
          const pct = Math.round(fraction * 100);
          this._setLoading(true, `正在快进到第 ${days} 天… ${pct}%`);
        },
      });

      this.simClock.syncToViewer(this.viewer);
      this.onJumpComplete?.();
      this.viewer.scene.requestRender();
    } catch (err) {
      console.error('Day jump failed:', err);
    } finally {
      this._setLoading(false);
      this.setJumping?.(false);
      this._busy = false;
    }
  }
}

export { PRESET_DAYS };
