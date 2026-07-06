import * as Cesium from 'cesium';
import {
  sampleGroundTrackPath,
  chainsToStripInstances,
} from './geometry.js';
import { swathColorForAge, fadeColorBucket, secondsToDays } from './fade.js';

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
 * 每圈绘制完整 ground track 大圆轨迹（极区汇聚）
 * 当前圈：Entity.corridor 每帧延伸（无 destroy 闪烁）
 * 已完成圈：GroundPrimitive + 按天褪色
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
    this.activeEntities = [];
    this.activeChains = [];
    this.passStartTime = null;
    this._passStartSec = null;
    this._lastSec = null;
    this._lastFadeWallMs = 0;
    this._activeColor = swathColorForAge(0, fadeConfig);
  }

  beginPass(currentTime, sec) {
    this.passStartTime = JulianDate.clone(currentTime, new JulianDate());
    this._passStartSec = sec;
    this._clearActiveEntities();
    this.activeChains = [];
  }

  /** 按轨道时间重采样当前圈 ground track（每帧实时延伸到星下点） */
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

    this.activeChains = sampleGroundTrackPath(
      this._passStartSec,
      currentSec,
      orbitPeriodSec,
      this.orbitConfig,
      this.sensorConfig,
      this.ellipsoid,
      this.orbitEpoch,
    );
    this.activeChains = _appendGroundTip(this.activeChains, currentGround);

    this._syncActiveCorridors(this.activeChains);
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

    this._clearActiveEntities();

    if (chains.length === 0) {
      this._passStartSec = null;
      this.passStartTime = null;
      this.activeChains = [];
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

    this.activeChains = [];
    this._passStartSec = null;
    this.passStartTime = null;
  }

  _syncActiveCorridors(chains) {
    const usable = chains.filter((c) => c.length >= 2);

    for (let i = 0; i < usable.length; i++) {
      const positions = usable[i].map((p) => Cartesian3.clone(p));
      let entity = this.activeEntities[i];
      if (!entity) {
        entity = this.viewer.entities.add({
          corridor: {
            positions,
            width: this.swathWidthM,
            cornerType: CornerType.MITERED,
            material: Color.clone(this._activeColor, new Color()),
            height: 0,
          },
        });
        this.activeEntities[i] = entity;
      } else {
        entity.corridor.positions = positions;
      }
    }

    while (this.activeEntities.length > usable.length) {
      const extra = this.activeEntities.pop();
      this.viewer.entities.remove(extra);
    }
  }

  _clearActiveEntities() {
    for (const entity of this.activeEntities) {
      this.viewer.entities.remove(entity);
    }
    this.activeEntities = [];
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
    this._clearActiveEntities();
    this.activeChains = [];
    this.passStartTime = null;
    this._passStartSec = null;
    this._lastSec = null;
  }

  clear() {
    this._clearActiveEntities();
    for (const pass of this.completedPasses) {
      this._destroyPrimitive(pass.primitive);
    }
    this.completedPasses = [];
    this.activeChains = [];
    this.passStartTime = null;
    this._passStartSec = null;
    this._lastSec = null;
    this._lastFadeWallMs = 0;
  }

  get count() {
    let n = this.completedPasses.length;
    if (this.activeEntities.some((e) => e?.show !== false)) n += 1;
    return n;
  }
}

function _appendGroundTip(chains, tip) {
  if (!tip || chains.length === 0) return chains;

  const out = chains.map((c) => c.map((p) => Cartesian3.clone(p)));
  const last = out[out.length - 1];
  const tipPt = Cartesian3.clone(tip);

  if (last.length === 0) {
    last.push(tipPt);
    return out;
  }

  const prev = last[last.length - 1];
  if (Cartesian3.distanceSquared(prev, tipPt) > 1) {
    last.push(tipPt);
  } else {
    last[last.length - 1] = tipPt;
  }

  return out;
}
