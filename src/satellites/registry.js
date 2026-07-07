import { Satellite } from './Satellite.js';

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
}
