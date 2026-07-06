import * as Cesium from 'cesium';
import {
  sampleGroundTrackPath,
  chainsToStripInstances,
} from './geometry.js';
import { swathColorForAge, secondsToDays } from './fade.js';

const {
  JulianDate,
  GroundPrimitive,
  PerInstanceColorAppearance,
  ClassificationType,
  Cartesian3,
} = Cesium;

/**
 * 每圈绘制完整 ground track 大圆轨迹（极区汇聚）
 * 当前圈：从圈起点实时延伸到当前时刻
 */
export class SwathManager {
  constructor(viewer, orbitConfig, sensorConfig, fadeConfig, orbitEpoch) {
    this.viewer = viewer;
    this.orbitConfig = orbitConfig;
    this.sensorConfig = sensorConfig;
    this.fadeConfig = fadeConfig;
    this.orbitEpoch = orbitEpoch;
    this.ellipsoid = viewer.scene.globe.ellipsoid;
    this.halfWidthM = (sensorConfig.swathWidthKm * 1000) / 2;

    this.completedPasses = [];
    this.activePrimitive = null;
    this.activeChains = [];
    this.passStartTime = null;
    this._passStartSec = null;
    this._lastSec = null;
  }

  beginPass(currentTime, sec) {
    this.passStartTime = JulianDate.clone(currentTime, new JulianDate());
    this._passStartSec = sec;
    this._destroyPrimitive(this.activePrimitive);
    this.activePrimitive = null;
    this.activeChains = [];
  }

  /** 按轨道时间重采样当前圈 ground track（实时延伸） */
  updateActivePass(currentTime, currentSec, orbitPeriodSec) {
    if (this._passStartSec === null) {
      this.beginPass(currentTime, currentSec);
    }

    if (this._lastSec !== null && currentSec < this._lastSec) {
      this.resetSampling();
      this.beginPass(currentTime, currentSec);
    }

    if (currentSec - this._passStartSec >= orbitPeriodSec * 0.995) {
      this.finalizePass(orbitPeriodSec);
      this.beginPass(currentTime, currentSec);
    }

    this.activeChains = sampleGroundTrackPath(
      this._passStartSec,
      currentSec,
      orbitPeriodSec,
      this.orbitConfig,
      this.sensorConfig,
      this.ellipsoid,
      this.orbitEpoch,
    );

    this._rebuildActivePrimitive(swathColorForAge(0, this.fadeConfig));
    this._lastSec = currentSec;
  }

  /** 完成一圈：绘制整圈 ground track */
  finalizePass(orbitPeriodSec) {
    if (this._passStartSec === null) return;

    const endSec = this._passStartSec + orbitPeriodSec;
    const chains = sampleGroundTrackPath(
      this._passStartSec,
      endSec,
      orbitPeriodSec,
      this.orbitConfig,
      this.sensorConfig,
      this.ellipsoid,
      this.orbitEpoch,
    );

    if (chains.length === 0) {
      this._destroyPrimitive(this.activePrimitive);
      this.activePrimitive = null;
      this._passStartSec = null;
      this.passStartTime = null;
      return;
    }

    this._destroyPrimitive(this.activePrimitive);
    this.activePrimitive = null;

    const color = swathColorForAge(0, this.fadeConfig);
    const primitive = this._buildStripFromChains(chains, color);
    if (primitive) {
      this.viewer.scene.groundPrimitives.add(primitive);
      this.completedPasses.push({
        primitive,
        cachedChains: chains.map((c) => c.map((p) => Cartesian3.clone(p))),
        acquisitionTime: JulianDate.clone(this.passStartTime, new JulianDate()),
        colorBucket: 0,
      });
    }

    this.activeChains = [];
    this._passStartSec = null;
    this.passStartTime = null;
  }

  _rebuildActivePrimitive(color) {
    this._destroyPrimitive(this.activePrimitive);
    this.activePrimitive = this._buildStripFromChains(this.activeChains, color);
    if (this.activePrimitive) {
      this.viewer.scene.groundPrimitives.add(this.activePrimitive);
    }
  }

  _buildStripFromChains(chains, color) {
    const instances = chainsToStripInstances(
      chains,
      this.halfWidthM,
      this.ellipsoid,
      color,
    );
    if (instances.length === 0) return null;

    try {
      return new GroundPrimitive({
        geometryInstances: instances,
        appearance: new PerInstanceColorAppearance({
          translucent: true,
          closed: true,
          flat: true,
        }),
        classificationType: ClassificationType.BOTH,
        asynchronous: false,
      });
    } catch (err) {
      console.warn('swath strip failed:', err);
      return null;
    }
  }

  _destroyPrimitive(primitive) {
    if (!primitive) return;
    this.viewer.scene.groundPrimitives.remove(primitive);
    if (!primitive.isDestroyed()) {
      primitive.destroy();
    }
  }

  updateFade(currentTime) {
    for (let i = this.completedPasses.length - 1; i >= 0; i--) {
      const pass = this.completedPasses[i];
      const ageSec = JulianDate.secondsDifference(
        currentTime,
        pass.acquisitionTime,
      );
      const ageDays = secondsToDays(ageSec);
      const color = swathColorForAge(ageDays, this.fadeConfig);

      if (color.alpha < 0.01) {
        this._destroyPrimitive(pass.primitive);
        this.completedPasses.splice(i, 1);
        continue;
      }

      const bucket = Math.floor(ageDays * 20);
      if (bucket !== pass.colorBucket) {
        pass.colorBucket = bucket;
        this._destroyPrimitive(pass.primitive);
        pass.primitive = this._buildStripFromChains(
          pass.cachedChains,
          color,
        );
        if (pass.primitive) {
          this.viewer.scene.groundPrimitives.add(pass.primitive);
        }
      }
    }
  }

  resetSampling() {
    this._destroyPrimitive(this.activePrimitive);
    this.activePrimitive = null;
    this.activeChains = [];
    this.passStartTime = null;
    this._passStartSec = null;
    this._lastSec = null;
  }

  clear() {
    this._destroyPrimitive(this.activePrimitive);
    this.activePrimitive = null;
    for (const pass of this.completedPasses) {
      this._destroyPrimitive(pass.primitive);
    }
    this.completedPasses = [];
    this.activeChains = [];
    this.passStartTime = null;
    this._passStartSec = null;
    this._lastSec = null;
  }

  get count() {
    let n = this.completedPasses.length;
    if (this.activeChains.some((c) => c.length >= 2)) n += 1;
    return n;
  }
}
