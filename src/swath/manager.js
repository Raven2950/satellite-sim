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
  Color,
  CornerType,
} = Cesium;

/** 已完成条带褪色检查最小墙钟间隔（毫秒） */
const FADE_CHECK_INTERVAL_MS = 1500;

/**
 * 每圈 ground track 条带
 * - 当前圈：已固化段 GroundPrimitive（按距离采样）+ 星下点尖端 corridor（每帧）
 * - 已完成圈：GroundPrimitive + 按天褪色（低频重建，不闪）
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
    this.swathWidthM = sensorConfig.swathWidthKm * 1000;

    this.completedPasses = [];
    this._activeAnchors = [];
    this._activeFrozenPrimitive = null;
    this._activeTipEntity = null;
    this.passStartTime = null;
    this._passStartSec = null;
    this._lastSec = null;
    this._lastFadeWallMs = 0;
    this._activeColor = swathColorForAge(0, fadeConfig);
  }

  beginPass(currentTime, sec) {
    this.passStartTime = JulianDate.clone(currentTime, new JulianDate());
    this._passStartSec = sec;
    this._clearActiveVisuals();
    this._activeAnchors = [];
  }

  /** 当前圈：每帧延伸星下点尖端，沿轨每 150 m 固化一段 */
  updateActivePass(currentTime, currentSec, orbitPeriodSec, currentGround) {
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

    if (currentGround) {
      this._extendActiveAnchors(currentGround);
      this._syncActiveTip(currentGround);
    }

    this._lastSec = currentSec;
  }

  _extendActiveAnchors(currentGround) {
    if (this._activeAnchors.length === 0) {
      this._activeAnchors.push(Cartesian3.clone(currentGround));
      return;
    }

    const last = this._activeAnchors[this._activeAnchors.length - 1];
    if (Cartesian3.distance(last, currentGround) >= SWATH_SAMPLE_INTERVAL_M) {
      this._activeAnchors.push(Cartesian3.clone(currentGround));
      this._rebuildActiveFrozen();
    }
  }

  _rebuildActiveFrozen() {
    if (this._activeAnchors.length < 2) {
      this._destroyPrimitive(this._activeFrozenPrimitive);
      this._activeFrozenPrimitive = null;
      return;
    }

    const chains = [
      this._activeAnchors.map((p) => Cartesian3.clone(p)),
    ];
    const next = this._buildStripFromChains(chains, this._activeColor);
    if (!next) return;

    this.viewer.scene.groundPrimitives.add(next);
    this._destroyPrimitive(this._activeFrozenPrimitive);
    this._activeFrozenPrimitive = next;
  }

  _syncActiveTip(currentGround) {
    const anchor =
      this._activeAnchors.length > 0
        ? this._activeAnchors[this._activeAnchors.length - 1]
        : null;
    if (!anchor) return;

    if (Cartesian3.distance(anchor, currentGround) < 0.5) {
      if (this._activeTipEntity) {
        this._activeTipEntity.show = false;
      }
      return;
    }

    const positions = [
      Cartesian3.clone(anchor),
      Cartesian3.clone(currentGround),
    ];

    if (!this._activeTipEntity) {
      this._activeTipEntity = this.viewer.entities.add({
        show: true,
        corridor: {
          positions,
          width: this.swathWidthM,
          cornerType: CornerType.MITERED,
          material: Color.clone(this._activeColor, new Color()),
          height: 0,
        },
      });
      return;
    }

    this._activeTipEntity.show = true;
    this._activeTipEntity.corridor.positions = positions;
  }

  /** 完成一圈：高精度采样后写入已完成圈 */
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

    this._clearActiveVisuals();
    this._activeAnchors = [];

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

  _clearActiveVisuals() {
    this._destroyPrimitive(this._activeFrozenPrimitive);
    this._activeFrozenPrimitive = null;
    if (this._activeTipEntity) {
      this.viewer.entities.remove(this._activeTipEntity);
      this._activeTipEntity = null;
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
    this._clearActiveVisuals();
    this._activeAnchors = [];
    this.passStartTime = null;
    this._passStartSec = null;
    this._lastSec = null;
  }

  clear() {
    this._clearActiveVisuals();
    for (const pass of this.completedPasses) {
      this._destroyPrimitive(pass.primitive);
    }
    this.completedPasses = [];
    this._activeAnchors = [];
    this.passStartTime = null;
    this._passStartSec = null;
    this._lastSec = null;
    this._lastFadeWallMs = 0;
  }

  get count() {
    let n = this.completedPasses.length;
    if (this._activeFrozenPrimitive || this._activeTipEntity?.show) n += 1;
    return n;
  }
}
