import * as Cesium from 'cesium';
import { orbitalPeriodSeconds } from '../orbit/propagate.js';
import { Satellite } from './Satellite.js';

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

  updateAll(currentTime) {
    for (const sat of this.satellites.values()) {
      sat.update(currentTime);
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
    let cells = 0;
    let rollDeg = 0;
    for (const sat of this.satellites.values()) {
      cells += sat.coverageCellCount;
      rollDeg = sat.currentRollDeg;
    }
    return { cells, rollDeg };
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

  _resetSimulationState() {
    for (const sat of this.satellites.values()) {
      sat.swathManager.clear();
      sat.coveragePlanner.reset();
      sat._lastFrameSec = null;
    }
  }

  /**
   * 离线快进到仿真第 targetDays 天（复用 Satellite.update，不改算法）
   */
  async simulateToSimDays(targetDays, simClock, { onProgress } = {}) {
    const days = Math.max(0, targetDays);
    const anchor = simClock.getSimAnchor();
    const totalSec = days * 86400;

    this._resetSimulationState();

    if (totalSec <= 0) {
      simClock.jumpToSimDays(0);
      onProgress?.(1);
      return;
    }

    const firstSat = this.satellites.values().next().value;
    const orbitPeriodSec = firstSat
      ? firstSat.orbitPeriodSec
      : orbitalPeriodSeconds(500);
    const stepSec = Math.max(orbitPeriodSec / 12, 30);

    const scratch = new JulianDate();
    let lastYieldSec = -Infinity;

    for (let sec = 0; sec <= totalSec; sec += stepSec) {
      const t = JulianDate.addSeconds(anchor, sec, scratch);
      this.updateAll(t);

      if (sec - lastYieldSec >= orbitPeriodSec * 2) {
        onProgress?.(Math.min(1, sec / totalSec));
        lastYieldSec = sec;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    const finalT = JulianDate.addSeconds(anchor, totalSec, scratch);
    this.updateAll(finalT);
    simClock.jumpToSimDays(days);
    onProgress?.(1);
  }
}
