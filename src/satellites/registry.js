import * as Cesium from 'cesium';
import { Satellite } from './Satellite.js';
import { computeJumpSamplesPerOrbit } from '../config/satellite.js';

const { JulianDate } = Cesium;

export class SatelliteRegistry {
  constructor(viewer, orbitEpoch) {
    this.viewer = viewer;
    this.orbitEpoch = orbitEpoch;
    this.satellites = new Map();
  }

  register(config) {
    if (this.satellites.has(config.id)) {
      this.unregister(config.id);
    }
    const sat = new Satellite(this.viewer, config, this.orbitEpoch);
    this.satellites.set(config.id, sat);
    return sat;
  }

  registerAll(configs) {
    return configs.map((c) => this.register(c));
  }

  loadAllModels() {
    return Promise.all(
      [...this.satellites.values()].map((sat) => sat.loadModel()),
    );
  }

  unregister(id) {
    const sat = this.satellites.get(id);
    if (sat) {
      sat.destroy();
      this.satellites.delete(id);
    }
  }

  updateAll(currentTime, options = {}) {
    for (const sat of this.satellites.values()) {
      sat.update(currentTime, options);
    }
  }

  getTotalSwathCount() {
    let n = 0;
    for (const sat of this.satellites.values()) {
      n += sat.swathCount;
    }
    return n;
  }

  getCoverageStats() {
    const satellites = [];
    let cells = 0;
    for (const sat of this.satellites.values()) {
      cells += sat.coverageCellCount;
      satellites.push({
        id: sat.config.id,
        name: sat.config.name,
        rollDeg: sat.currentRollDeg,
        swathCount: sat.swathCount,
      });
    }
    return { cells, satellites };
  }

  destroyAll() {
    for (const id of [...this.satellites.keys()]) {
      this.unregister(id);
    }
  }

  resetAll() {
    const configs = [...this.satellites.values()].map((s) => s.config);
    this.destroyAll();
    this.registerAll(configs);
  }

  replaceAll(configs) {
    this.destroyAll();
    this.registerAll(configs);
  }

  _resetSimulationState() {
    for (const sat of this.satellites.values()) {
      sat.sensorCone?.setVisible(false);
      sat.swathManager.clear();
      sat.coveragePlanner.reset();
      sat._lastFrameSec = null;
    }
  }

  _prepareVisualsAfterJump() {
    for (const sat of this.satellites.values()) {
      sat.sensorCone?.setVisible(false);
      sat.swathManager.resetSampling();
    }
  }

  /**
   * 离线快进到仿真第 targetDays 天
   * 多星与单星走同一条 simulateToSec 链路（采样完再 flush），
   * 双星 30 天 ≡ 单星 60 天的总痕迹量。
   */
  async simulateToSimDays(targetDays, simClock, { onProgress } = {}) {
    const days = Math.max(0, targetDays);
    const anchor = simClock.getSimAnchor();
    const totalSec = days * 86400;
    const scratch = new JulianDate();

    this._resetSimulationState();

    if (totalSec <= 0) {
      simClock.jumpToSimDays(0);
      const resetTime = JulianDate.clone(anchor, scratch);
      this.updateAll(resetTime);
      onProgress?.(1);
      return;
    }

    const satellites = [...this.satellites.values()];
    const totalSatDays = days * satellites.length;
    const jumpSamples = computeJumpSamplesPerOrbit(
      totalSatDays,
      satellites[0].orbitPeriodSec,
    );

    for (let i = 0; i < satellites.length; i++) {
      const sat = satellites[i];
      await sat.simulateToSec(anchor, totalSec, {
        samplesPerOrbit: jumpSamples,
        onProgress: (fraction) => {
          onProgress?.(((i + fraction) / satellites.length) * 0.95);
        },
      });
    }

    const finalT = JulianDate.addSeconds(anchor, totalSec, scratch);
    simClock.jumpToSimDays(days);
    this._prepareVisualsAfterJump();
    this.updateAll(finalT);
    onProgress?.(1);
  }
}
