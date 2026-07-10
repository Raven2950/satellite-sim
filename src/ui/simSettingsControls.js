import {
  PARAM_LIMITS,
  createDefaultSatelliteSpec,
  satelliteDisplayName,
} from '../config/satellite.js';

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export class SimSettingsControls {
  constructor({ initialParams, onApply }) {
    this.params = this._normalizeParams(initialParams);
    this.onApply = onApply;
    this.countInput = document.getElementById('satelliteCountInput');
    this.paramsList = document.getElementById('satelliteParamsList');
    this.hideToggle = document.getElementById('hideAfterCycleToggle');
    this.applyBtn = document.getElementById('btnApplySettings');
    this._busy = false;

    this._syncCountInput();
    this._renderSatelliteRows();
    this._syncHideToggle();
    this._bindEvents();
  }

  _normalizeParams(params) {
    const count = clamp(
      Number(params?.satelliteCount),
      PARAM_LIMITS.satelliteCount.min,
      PARAM_LIMITS.satelliteCount.max,
    );
    const satellites = Array.isArray(params?.satellites)
      ? params.satellites.map((spec) => ({
          altitudeKm: clamp(
            Number(spec?.altitudeKm),
            PARAM_LIMITS.altitudeKm.min,
            PARAM_LIMITS.altitudeKm.max,
          ),
          swathWidthKm: clamp(
            Number(spec?.swathWidthKm),
            PARAM_LIMITS.swathWidthKm.min,
            PARAM_LIMITS.swathWidthKm.max,
          ),
        }))
      : [];

    while (satellites.length < count) {
      satellites.push(createDefaultSatelliteSpec());
    }

    return {
      satelliteCount: count,
      hideAfterCycle: params?.hideAfterCycle !== false,
      satellites: satellites.slice(0, count),
    };
  }

  _syncCountInput() {
    const { satelliteCount } = PARAM_LIMITS;
    if (this.countInput) {
      this.countInput.min = String(satelliteCount.min);
      this.countInput.max = String(satelliteCount.max);
      this.countInput.step = String(satelliteCount.step);
      this.countInput.value = String(this.params.satelliteCount);
    }
  }

  _syncHideToggle() {
    if (this.hideToggle) {
      this.hideToggle.checked = this.params.hideAfterCycle;
    }
  }

  _renderSatelliteRows() {
    if (!this.paramsList) return;

    const { altitudeKm, swathWidthKm } = PARAM_LIMITS;
    this.paramsList.innerHTML = this.params.satellites
      .map(
        (spec, index) => `
        <div class="satellite-param-card" data-sat-index="${index}">
          <div class="satellite-param-title">${satelliteDisplayName(index)}</div>
          <label class="settings-field">
            <span>轨道高度 (km)</span>
            <input
              type="number"
              class="settings-input sat-alt-input"
              data-sat-index="${index}"
              min="${altitudeKm.min}"
              max="${altitudeKm.max}"
              step="${altitudeKm.step}"
              value="${spec.altitudeKm}"
            />
          </label>
          <label class="settings-field">
            <span>传感器视场 (km)</span>
            <input
              type="number"
              class="settings-input sat-swath-input"
              data-sat-index="${index}"
              min="${swathWidthKm.min}"
              max="${swathWidthKm.max}"
              step="${swathWidthKm.step}"
              value="${spec.swathWidthKm}"
            />
          </label>
        </div>
      `,
      )
      .join('');
  }

  _resizeSatelliteRows(count) {
    const next = clamp(
      count,
      PARAM_LIMITS.satelliteCount.min,
      PARAM_LIMITS.satelliteCount.max,
    );
    const current = this._readSatelliteSpecsFromDom();

    while (current.length < next) {
      const template =
        current[current.length - 1] ?? createDefaultSatelliteSpec();
      current.push({ ...template });
    }

    this.params.satelliteCount = next;
    this.params.satellites = current.slice(0, next);
    this._syncCountInput();
    this._renderSatelliteRows();
  }

  _readSatelliteSpecsFromDom() {
    const { altitudeKm, swathWidthKm } = PARAM_LIMITS;
    const specs = [];

    for (let i = 0; i < this.params.satelliteCount; i++) {
      const altEl = this.paramsList?.querySelector(
        `.sat-alt-input[data-sat-index="${i}"]`,
      );
      const swathEl = this.paramsList?.querySelector(
        `.sat-swath-input[data-sat-index="${i}"]`,
      );
      const fallback = this.params.satellites[i] ?? createDefaultSatelliteSpec();

      specs.push({
        altitudeKm: clamp(
          Number(altEl?.value ?? fallback.altitudeKm),
          altitudeKm.min,
          altitudeKm.max,
        ),
        swathWidthKm: clamp(
          Number(swathEl?.value ?? fallback.swathWidthKm),
          swathWidthKm.min,
          swathWidthKm.max,
        ),
      });
    }

    return specs;
  }

  _readParams() {
    const count = clamp(
      Number(this.countInput?.value),
      PARAM_LIMITS.satelliteCount.min,
      PARAM_LIMITS.satelliteCount.max,
    );

    if (count !== this.params.satelliteCount) {
      this._resizeSatelliteRows(count);
    }

    return this._normalizeParams({
      satelliteCount: count,
      satellites: this._readSatelliteSpecsFromDom(),
      hideAfterCycle: Boolean(this.hideToggle?.checked),
    });
  }

  _bindEvents() {
    this.countInput?.addEventListener('change', () => {
      this._resizeSatelliteRows(Number(this.countInput.value));
    });
    this.applyBtn?.addEventListener('click', () => this._handleApply());
  }

  async _handleApply() {
    if (this._busy) return;

    const next = this._readParams();
    this._busy = true;
    this.applyBtn.disabled = true;

    try {
      await this.onApply(next);
      this.params = {
        ...next,
        satellites: next.satellites.map((spec) => ({ ...spec })),
      };
      this._syncCountInput();
      this._renderSatelliteRows();
      this._syncHideToggle();
    } finally {
      this._busy = false;
      this.applyBtn.disabled = false;
    }
  }
}
