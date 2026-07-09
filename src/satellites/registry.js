import * as Cesium from 'cesium';
import { Satellite } from './Satellite.js';
import { JUMP_FLUSH_EVERY_ORBITS } from '../config/satellite.js';

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
   * 离线快进到仿真第 targetDays 天（按圈采样，结束时一次性刷新场景）
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
    const orbitCount = satellites[0].beginJumpSimulation(anchor, totalSec);
    for (let s = 1; s < satellites.length; s++) {
      satellites[s].beginJumpSimulation(anchor, totalSec);
    }

    if (orbitCount <= 0) {
      for (const sat of satellites) {
        sat.swathManager.endJumpSim();
      }
    } else {
      // 双星按圈交错推进，避免「第一颗全量 + 第二颗叠加」导致内存峰值翻倍
      for (let i = 0; i < orbitCount; i++) {
        for (const sat of satellites) {
          sat.simulateJumpOrbit(i);
        }

        if (i > 0 && i % JUMP_FLUSH_EVERY_ORBITS === 0) {
          for (const sat of satellites) {
            await sat.swathManager.flushJumpBucketsPartial();
          }
          onProgress?.((i / orbitCount) * 0.95);
          await new Promise((resolve) => setTimeout(resolve, 0));
        } else if (i % 15 === 0) {
          onProgress?.((i / orbitCount) * 0.95);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }

      for (const sat of satellites) {
        await sat.finalizeJumpSimulation(totalSec);
      }
    }

    const finalT = JulianDate.addSeconds(anchor, totalSec, scratch);
    simClock.jumpToSimDays(days);
    this._prepareVisualsAfterJump();
    this.updateAll(finalT);
    onProgress?.(1);
  }
}
