import * as Cesium from 'cesium';
import {
  sampleGroundTrackPath,
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
 * 单条轨迹链：对地点 + 偏转补扫点顺序记录，避免双链断点
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
    this._activePoints = [];
    this.passStartTime = null;
    this._passStartSec = null;
    this._lastSec = null;
    this._lastFadeWallMs = 0;
    this._activeColor = swathColorForAge(0, fadeConfig);
  }

  beginPass(currentTime, sec) {
    this.passStartTime = JulianDate.clone(currentTime, new JulianDate());
    this._passStartSec = sec;
    this._destroyPrimitive(this.activePrimitive);
    this.activePrimitive = null;
    this._activePoints = [];
  }

  /**
   * @param {{ nadirGround: Cartesian3, rollGround?: Cartesian3|null }} imaging
   */
  updateActivePass(currentTime, currentSec, orbitPeriodSec, imaging) {
    if (this._passStartSec === null) {
      this.beginPass(currentTime, currentSec);
    }

    if (this._lastSec !== null && currentSec < this._lastSec) {
      this.finalizePass();
      this.resetSampling();
      this.beginPass(currentTime, currentSec);
    }

    while (
      this._passStartSec !== null &&
      currentSec - this._passStartSec >= orbitPeriodSec * 0.995
    ) {
      this.finalizePass();
      this.beginPass(currentTime, currentSec);
    }

    if (imaging?.nadirGround) {
      this._recordImagingPoints(imaging);
      this._rebuildActiveFromPoints();
    }

    this._lastSec = currentSec;
  }

  /** 记录本帧成像地面点（对地 + 可选偏转补扫） */
  _recordImagingPoints(imaging) {
    this._advanceActivePoints(this._activePoints, imaging.nadirGround);
    if (imaging.rollGround) {
      const last = this._activePoints[this._activePoints.length - 1];
      if (Cartesian3.distanceSquared(last, imaging.rollGround) > 1) {
        this._advanceActivePoints(this._activePoints, imaging.rollGround);
      }
    }
  }

  _advanceActivePoints(points, ground) {
    if (points.length === 0) {
      points.push(Cartesian3.clone(ground));
      return;
    }

    if (points.length === 1) {
      const start = points[0];
      if (Cartesian3.distanceSquared(start, ground) > 0.01) {
        points.push(Cartesian3.clone(ground));
      }
      return;
    }

    const tipIdx = points.length - 1;
    const prev = points[tipIdx - 1];
    points[tipIdx] = Cartesian3.clone(ground);

    if (Cartesian3.distance(prev, ground) >= SWATH_SAMPLE_INTERVAL_M) {
      points.push(Cartesian3.clone(ground));
    }
  }

  _rebuildActiveFromPoints() {
    if (this._activePoints.length < 2) return;

    const chains = [this._activePoints.map((p) => Cartesian3.clone(p))];
    const next = this._buildStripFromChains(chains, this._activeColor);
    if (!next) return;
    this.viewer.scene.groundPrimitives.add(next);
    this._destroyPrimitive(this.activePrimitive);
    this.activePrimitive = next;
  }

  finalizePass() {
    if (this._passStartSec === null) return;

    const chains =
      this._activePoints.length >= 2
        ? [this._activePoints.map((p) => Cartesian3.clone(p))]
        : [];

    this._destroyPrimitive(this.activePrimitive);
    this.activePrimitive = null;

    if (chains.length > 0) {
      const color = swathColorForAge(0, this.fadeConfig);
      const primitive = this._buildStripFromChains(chains, color);
      if (primitive) {
        this.viewer.scene.groundPrimitives.add(primitive);
        this.completedPasses.push({
          primitive,
          cachedChains: chains.map((c) => c.map((p) => Cartesian3.clone(p))),
          acquisitionTime: JulianDate.clone(
            this.passStartTime,
            new JulianDate(),
          ),
          colorBucket: fadeColorBucket(0, this.fadeConfig),
        });
      }
    }

    this._activePoints = [];
    this._passStartSec = null;
    this.passStartTime = null;
  }

  /** 整圈高精度重采样（用于时间大跳后的补全） */
  resamplePassRange(startSec, endSec, orbitPeriodSec, sampleImaging) {
    const stepSec = Math.max(
      orbitPeriodSec / 360,
      SWATH_SAMPLE_INTERVAL_M / 7500,
    );
    const nadirPts = [];
    const rollPts = [];

    for (let t = startSec; t <= endSec + stepSec * 0.01; t += stepSec) {
      const sampleT = Math.min(t, endSec);
      const imaging = sampleImaging(sampleT);
      if (!imaging?.nadirGround) continue;

      this._advanceActivePoints(nadirPts, imaging.nadirGround);
      if (imaging.rollGround) {
        this._advanceActivePoints(rollPts, imaging.rollGround);
      }
      if (sampleT >= endSec) break;
    }

    const chains = [];
    if (nadirPts.length >= 2) chains.push(nadirPts);
    if (rollPts.length >= 2) chains.push(rollPts);

    if (chains.length === 0) return;

    const color = swathColorForAge(0, this.fadeConfig);
    const primitive = this._buildStripFromChains(chains, color);
    if (!primitive) return;

    this.viewer.scene.groundPrimitives.add(primitive);
    this.completedPasses.push({
      primitive,
      cachedChains: chains.map((c) => c.map((p) => Cartesian3.clone(p))),
      acquisitionTime: JulianDate.clone(this.orbitEpoch, new JulianDate()),
      colorBucket: fadeColorBucket(0, this.fadeConfig),
    });
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
    this._activePoints = [];
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
