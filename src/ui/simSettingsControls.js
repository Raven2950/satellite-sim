import { PARAM_LIMITS } from '../config/satellite.js';

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export class SimSettingsControls {
  constructor({ initialParams, onApply }) {
    this.params = { ...initialParams };
    this.onApply = onApply;
    this.altInput = document.getElementById('altitudeInput');
    this.swathInput = document.getElementById('swathInput');
    this.hideToggle = document.getElementById('hideAfterCycleToggle');
    this.applyBtn = document.getElementById('btnApplySettings');
    this._busy = false;

    this._syncInputs();
    this._bindEvents();
  }

  _syncInputs() {
    const { altitudeKm, swathWidthKm } = PARAM_LIMITS;
    if (this.altInput) {
      this.altInput.min = String(altitudeKm.min);
      this.altInput.max = String(altitudeKm.max);
      this.altInput.step = String(altitudeKm.step);
      this.altInput.value = String(this.params.altitudeKm);
    }
    if (this.swathInput) {
      this.swathInput.min = String(swathWidthKm.min);
      this.swathInput.max = String(swathWidthKm.max);
      this.swathInput.step = String(swathWidthKm.step);
      this.swathInput.value = String(this.params.swathWidthKm);
    }
    if (this.hideToggle) {
      this.hideToggle.checked = this.params.hideAfterCycle;
    }
  }

  _readParams() {
    const { altitudeKm, swathWidthKm } = PARAM_LIMITS;
    return {
      altitudeKm: clamp(
        Number(this.altInput?.value),
        altitudeKm.min,
        altitudeKm.max,
      ),
      swathWidthKm: clamp(
        Number(this.swathInput?.value),
        swathWidthKm.min,
        swathWidthKm.max,
      ),
      hideAfterCycle: Boolean(this.hideToggle?.checked),
    };
  }

  _bindEvents() {
    this.applyBtn?.addEventListener('click', () => this._handleApply());
  }

  async _handleApply() {
    if (this._busy) return;

    const next = this._readParams();
    this._busy = true;
    this.applyBtn.disabled = true;

    try {
      await this.onApply(next);
      this.params = { ...next };
      this._syncInputs();
    } finally {
      this._busy = false;
      this.applyBtn.disabled = false;
    }
  }
}
