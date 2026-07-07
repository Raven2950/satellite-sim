import * as Cesium from 'cesium';
import {
  sampleGroundTrackPath,
  sampleOrbitSwathChains,
  chainsToStripInstances,
} from './geometry.js';
import { swathColorForAge, fadeColorBucket, secondsToDays } from './fade.js';
import { SWATH_SAMPLE_INTERVAL_M } from '../config/satellite.js';

const {
  JulianDate,
  GroundPrimitive,
  PerInstanceColorAppearance,
  ClassificationType,
  Cartesian3,
} = Cesium;

/** 已完成条带褪色检查最小墙钟间隔（毫秒） */
const FADE_CHECK_INTERVAL_MS = 1500;

/**
 * 每圈 ground track 条带
 * - 当前圈：每帧 GroundPrimitive 重建（实时跟随星下点）
 * - 已完成圈：按天褪色 + 节流（避免历史轨迹闪烁）
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
    this._pendingPasses = [];
    this.activePrimitive = null;
    this._activePoints = [];
    this._activeRollPoints = [];
    this.passStartTime = null;
    this._passStartSec = null;
    this._lastSec = null;
    this._lastFadeWallMs = 0;
    this._coveragePlanner = null;
    this._activeColor = swathColorForAge(0, fadeConfig);
  }

  beginPass(currentTime, sec) {
    this.passStartTime = JulianDate.clone(currentTime, new JulianDate());
    this._passStartSec = sec;
    this._destroyPrimitive(this.activePrimitive);
    this.activePrimitive = null;
    this._activePoints = [];
    this._activeRollPoints = [];
  }

  /** 当前圈：每帧延伸到星下点（含偏转补扫轨迹） */
  updateActivePass(
    currentTime,
    currentSec,
    orbitPeriodSec,
    nadirGround,
    rollGround = null,
  ) {
    if (this._passStartSec === null) {
      this.beginPass(currentTime, currentSec);
    }

    if (this._lastSec !== null && currentSec < this._lastSec) {
      this.resetSampling();
      this.beginPass(currentTime, currentSec);
    }

    if (currentSec - this._passStartSec >= orbitPeriodSec * 0.995) {
      this.finalizePass(orbitPeriodSec, this._coveragePlanner);
      this.beginPass(currentTime, currentSec);
    }

    if (nadirGround) {
      this._advanceActivePoints(nadirGround, this._activePoints);
    }
    if (rollGround) {
      this._advanceActivePoints(rollGround, this._activeRollPoints);
    }

    const chains = [];
    if (this._activePoints.length >= 2) {
      chains.push(this._activePoints.map((p) => Cartesian3.clone(p)));
    }
    if (this._activeRollPoints.length >= 2) {
      chains.push(this._activeRollPoints.map((p) => Cartesian3.clone(p)));
    }
    if (chains.length > 0) {
      this._rebuildActivePrimitive(chains);
    }

    this._lastSec = currentSec;
  }

  setCoveragePlanner(coveragePlanner) {
    this._coveragePlanner = coveragePlanner;
  }

  _advanceActivePoints(currentGround, points) {
    if (points.length === 0) {
      points.push(Cartesian3.clone(currentGround));
      return;
    }

    if (points.length === 1) {
      const start = points[0];
      if (Cartesian3.distanceSquared(start, currentGround) > 0.01) {
        points.push(Cartesian3.clone(currentGround));
      }
      return;
    }

    const tipIdx = points.length - 1;
    const prev = points[tipIdx - 1];
    points[tipIdx] = Cartesian3.clone(currentGround);

    if (Cartesian3.distance(prev, currentGround) >= SWATH_SAMPLE_INTERVAL_M) {
      points.push(Cartesian3.clone(currentGround));
    }
  }

  _rebuildActivePrimitive(chains) {
    const next = this._buildStripFromChains(chains, this._activeColor);
    if (!next) return;
    this.viewer.scene.groundPrimitives.add(next);
    this._destroyPrimitive(this.activePrimitive);
    this.activePrimitive = next;
  }

  /** 离线快进：采样一整圈轨迹（对地 + 偏转），暂存链式点列 */
  simulateOrbitPass(passStartSec, orbitPeriodSec, passStartTime, coveragePlanner) {
    const chains = sampleOrbitSwathChains(
      passStartSec,
      orbitPeriodSec,
      this.orbitConfig,
      this.sensorConfig,
      coveragePlanner,
      this.ellipsoid,
      this.orbitEpoch,
      { markGrid: true },
    );

    if (chains.length === 0) return;

    this._pendingPasses.push({
      cachedChains: chains.map((c) => c.map((p) => Cartesian3.clone(p))),
      acquisitionTime: JulianDate.clone(passStartTime, new JulianDate()),
    });
  }

  /** 将离线暂存的条带批量提交到场景 */
  async flushPendingPasses(currentTime, { onProgress } = {}) {
    const pending = this._pendingPasses;
    this._pendingPasses = [];
    if (pending.length === 0) return;

    const batchSize = 40;
    for (let i = 0; i < pending.length; i++) {
      const pass = pending[i];
      const ageSec = JulianDate.secondsDifference(
        currentTime,
        pass.acquisitionTime,
      );
      const ageDays = secondsToDays(ageSec);
      const color = swathColorForAge(ageDays, this.fadeConfig);
      if (color.alpha < 0.01) continue;

      const primitive = this._buildStripFromChains(pass.cachedChains, color);
      if (primitive) {
        this.viewer.scene.groundPrimitives.add(primitive);
        this.completedPasses.push({
          primitive,
          cachedChains: pass.cachedChains,
          acquisitionTime: pass.acquisitionTime,
          colorBucket: fadeColorBucket(ageDays, this.fadeConfig),
        });
      }

      if (i % batchSize === batchSize - 1) {
        onProgress?.((i + 1) / pending.length);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    onProgress?.(1);
  }

  finalizePass(orbitPeriodSec, coveragePlanner) {
    if (this._passStartSec === null) return;

    const chains = coveragePlanner
      ? sampleOrbitSwathChains(
          this._passStartSec,
          orbitPeriodSec,
          this.orbitConfig,
          this.sensorConfig,
          coveragePlanner,
          this.ellipsoid,
          this.orbitEpoch,
          { markGrid: false },
        )
      : sampleGroundTrackPath(
          this._passStartSec,
          this._passStartSec + orbitPeriodSec,
          orbitPeriodSec,
          this.orbitConfig,
          { ...this.sensorConfig, rollDeg: 0 },
          this.ellipsoid,
          this.orbitEpoch,
        );

    this._destroyPrimitive(this.activePrimitive);
    this.activePrimitive = null;
    this._activePoints = [];
    this._activeRollPoints = [];

    if (chains.length === 0) {
      this._passStartSec = null;
      this.passStartTime = null;
      return;
    }

    const color = swathColorForAge(0, this.fadeConfig);
    const primitive = this._buildStripFromChains(chains, color);
    if (primitive) {
      this.viewer.scene.groundPrimitives.add(primitive);
      this.completedPasses.push({
        primitive,
        cachedChains: chains.map((c) => c.map((p) => Cartesian3.clone(p))),
        acquisitionTime: JulianDate.clone(this.passStartTime, new JulianDate()),
        colorBucket: fadeColorBucket(0, this.fadeConfig),
      });
    }

    this._passStartSec = null;
    this.passStartTime = null;
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
        classificationType: ClassificationType.TERRAIN,
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
    const wallNow = performance.now();
    const allowRebuild =
      wallNow - this._lastFadeWallMs >= FADE_CHECK_INTERVAL_MS;
    if (allowRebuild) this._lastFadeWallMs = wallNow;

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

      if (!allowRebuild) continue;

      const bucket = fadeColorBucket(ageDays, this.fadeConfig);
      if (bucket === pass.colorBucket) continue;

      pass.colorBucket = bucket;
      const next = this._buildStripFromChains(pass.cachedChains, color);
      if (!next) continue;

      this.viewer.scene.groundPrimitives.add(next);
      this._destroyPrimitive(pass.primitive);
      pass.primitive = next;
    }
  }

  resetSampling() {
    this._destroyPrimitive(this.activePrimitive);
    this.activePrimitive = null;
    this._activePoints = [];
    this._activeRollPoints = [];
    this.passStartTime = null;
    this._passStartSec = null;
    this._lastSec = null;
  }

  clear() {
    this._pendingPasses = [];
    this._destroyPrimitive(this.activePrimitive);
    this.activePrimitive = null;
    for (const pass of this.completedPasses) {
      this._destroyPrimitive(pass.primitive);
    }
    this.completedPasses = [];
    this._activePoints = [];
    this._activeRollPoints = [];
    this.passStartTime = null;
    this._passStartSec = null;
    this._lastSec = null;
    this._lastFadeWallMs = 0;
  }

  get count() {
    let n = this.completedPasses.length;
    if (this.activePrimitive) n += 1;
    return n;
  }
}
