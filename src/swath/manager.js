import * as Cesium from 'cesium';
import {
  sampleOrbitSwathChains,
  sampleOrbitCoveragePass,
  estimateStripInstances,
  stitchAdjacentChains,
  chainsToStripInstances,
} from './geometry.js';
import {
  swathColorForAge,
  fadeColorBucket,
  secondsToDays,
  shouldHideSwath,
} from './fade.js';
import {
  SWATH_SAMPLE_INTERVAL_M,
  JUMP_SAMPLES_PER_ORBIT,
  COVERAGE_JUMP_SAMPLES_PER_ORBIT,
  SWATH_INSTANCES_PER_PRIMITIVE,
} from '../config/satellite.js';

const {
  JulianDate,
  GroundPrimitive,
  PerInstanceColorAppearance,
  ClassificationType,
  Cartesian3,
} = Cesium;

/** 已完成条带褪色检查最小墙钟间隔（毫秒） */
const FADE_CHECK_INTERVAL_MS = 1500;
/** 倍速播放时褪色重建最小间隔（毫秒） */
const FADE_FAST_PLAYBACK_MS = 10_000;
/** 当前圈条带重建最小墙钟间隔（毫秒） */
const ACTIVE_REBUILD_MIN_MS = 180;

/**
 * 每圈 ground track 条带
 * - 当前圈：每帧 GroundPrimitive 重建（实时跟随星下点）
 * - 已完成圈：按天褪色 + 节流（避免历史轨迹闪烁）
 * - 离线跳转：按褪色分桶批量合并 primitive，增量 flush 降低内存峰值
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
    this._activeChains = [];
    this._activePoints = [];
    this.passStartTime = null;
    this._passStartSec = null;
    this._lastSec = null;
    this._lastFadeWallMs = 0;
    this._coveragePlanner = null;
    this._activeRolled = false;
    this._activeColor = swathColorForAge(0, fadeConfig);

    this._jumpFinalTime = null;
    this._jumpBuckets = null;
    this._activeDirty = false;
    this._lastActiveRebuildMs = 0;
  }

  beginPass(currentTime, sec) {
    this.passStartTime = JulianDate.clone(currentTime, new JulianDate());
    this._passStartSec = sec;
    this._destroyPrimitive(this.activePrimitive);
    this.activePrimitive = null;
    this._activeChains = [];
    this._activePoints = [];
    this._activeRolled = false;
    this._coveragePlanner?.beginPass();
  }

  /** 离线跳转开始前设置目标时刻（用于计算褪色分桶） */
  beginJumpSim(finalTime) {
    this._jumpFinalTime = JulianDate.clone(finalTime, new JulianDate());
    this._jumpBuckets = new Map();
  }

  endJumpSim() {
    this._jumpFinalTime = null;
    this._jumpBuckets = null;
  }

  preparePassFrame(currentTime, currentSec, orbitPeriodSec) {
    if (this._passStartSec === null) {
      this.beginPass(currentTime, currentSec);
      return;
    }

    if (this._lastSec !== null && currentSec < this._lastSec) {
      this.resetSampling();
      this.beginPass(currentTime, currentSec);
      return;
    }

    if (currentSec - this._passStartSec >= orbitPeriodSec * 0.995) {
      this.finalizePass(orbitPeriodSec, this._coveragePlanner);
      this.beginPass(currentTime, currentSec);
    }
  }

  appendSwathSample(swathGround, { deferRebuild = false } = {}) {
    if (!swathGround) return;
    this._advanceActivePoints(swathGround, this._activePoints);
    if (deferRebuild) {
      this._activeDirty = true;
      return;
    }
    this._rebuildActiveChains(true);
  }

  /** 稠密补采样结束后一次性重建当前圈条带 */
  flushActiveRebuild() {
    if (!this._activeDirty && this._activePoints.length < 2) return;
    this._rebuildActiveChains(true);
    this._activeDirty = false;
  }

  updateActivePass(currentTime, currentSec, orbitPeriodSec, swathGround) {
    this.preparePassFrame(currentTime, currentSec, orbitPeriodSec);
    this.appendSwathSample(swathGround);
    this._lastSec = currentSec;
  }

  _collectActiveChains() {
    const raw = [];
    for (const chain of this._activeChains) {
      if (chain.length >= 2) {
        raw.push(chain.map((p) => Cartesian3.clone(p)));
      }
    }
    if (this._activePoints.length >= 2) {
      raw.push(this._activePoints.map((p) => Cartesian3.clone(p)));
    }
    return stitchAdjacentChains(raw, this.ellipsoid);
  }

  _rebuildActiveChains(force = false) {
    if (this._activePoints.length < 2) return;
    const now = performance.now();
    if (!force && now - this._lastActiveRebuildMs < ACTIVE_REBUILD_MIN_MS) {
      this._activeDirty = true;
      return;
    }
    this._lastActiveRebuildMs = now;
    this._activeDirty = false;
    this._rebuildActivePrimitive([this._activePoints]);
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
    if (Cartesian3.distance(points[tipIdx], currentGround) < 0.5) {
      return;
    }
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

  /** 离线快进：按褪色分桶累积，满批即 flush */
  simulateOrbitPass(passStartSec, orbitPeriodSec, passStartTime, coveragePlanner) {
    if (!this._jumpFinalTime || !this._jumpBuckets) {
      console.warn('simulateOrbitPass called outside jump sim');
      return;
    }

    const ageSec = JulianDate.secondsDifference(
      this._jumpFinalTime,
      passStartTime,
    );
    const ageDays = secondsToDays(ageSec);

    const coverageOpts = {
      samplesPerOrbit: COVERAGE_JUMP_SAMPLES_PER_ORBIT,
    };

    if (shouldHideSwath(ageDays, this.fadeConfig)) {
      sampleOrbitCoveragePass(
        passStartSec,
        orbitPeriodSec,
        this.orbitConfig,
        this.sensorConfig,
        coveragePlanner,
        this.ellipsoid,
        this.orbitEpoch,
        coverageOpts,
      );
      return;
    }

    const chains = sampleOrbitSwathChains(
      passStartSec,
      orbitPeriodSec,
      this.orbitConfig,
      this.sensorConfig,
      coveragePlanner,
      this.ellipsoid,
      this.orbitEpoch,
      { markGrid: false, samplesPerOrbit: JUMP_SAMPLES_PER_ORBIT },
    );

    sampleOrbitCoveragePass(
      passStartSec,
      orbitPeriodSec,
      this.orbitConfig,
      this.sensorConfig,
      coveragePlanner,
      this.ellipsoid,
      this.orbitEpoch,
      coverageOpts,
    );

    if (chains.length === 0) return;

    const bucket = fadeColorBucket(ageDays, this.fadeConfig);
    let acc = this._jumpBuckets.get(bucket);
    if (!acc) {
      acc = {
        chains: [],
        instances: 0,
        colorBucket: bucket,
        acquisitionTime: JulianDate.clone(passStartTime, new JulianDate()),
      };
      this._jumpBuckets.set(bucket, acc);
    }

    for (const chain of chains) {
      acc.chains.push(chain);
      acc.instances += estimateStripInstances([chain]);
    }

    if (acc.instances >= SWATH_INSTANCES_PER_PRIMITIVE) {
      this._flushJumpBucket(bucket);
    }
  }

  /** 跳转过程中周期性 flush，释放累积内存 */
  async flushJumpBucketsPartial() {
    if (!this._jumpBuckets?.size) return;

    for (const bucket of [...this._jumpBuckets.keys()]) {
      const acc = this._jumpBuckets.get(bucket);
      if (acc?.instances > 0) {
        this._flushJumpBucket(bucket);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** 跳转结束：flush 所有剩余分桶 */
  async flushJumpBucketsFinal() {
    if (!this._jumpBuckets?.size) return;

    for (const bucket of [...this._jumpBuckets.keys()]) {
      const acc = this._jumpBuckets.get(bucket);
      if (acc?.instances > 0) {
        this._flushJumpBucket(bucket);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  _flushJumpBucket(bucket) {
    const acc = this._jumpBuckets.get(bucket);
    if (!acc || acc.instances <= 0 || acc.chains.length === 0) {
      this._jumpBuckets.delete(bucket);
      return;
    }

    const ageSec = JulianDate.secondsDifference(
      this._jumpFinalTime,
      acc.acquisitionTime,
    );
    const ageDays = secondsToDays(ageSec);
    const color = swathColorForAge(ageDays, this.fadeConfig);

    const chains = acc.chains;
    const primitive = this._buildStripFromChains(chains, color, {
      asynchronous: true,
    });
    acc.chains = null;
    if (primitive) {
      this.viewer.scene.groundPrimitives.add(primitive);
      this.completedPasses.push({
        primitive,
        cachedChains: null,
        acquisitionTime: JulianDate.clone(
          acc.acquisitionTime,
          new JulianDate(),
        ),
        colorBucket: bucket,
      });
    }

    this._jumpBuckets.delete(bucket);
  }

  finalizePass(orbitPeriodSec, coveragePlanner) {
    if (this._passStartSec === null) return;

    const chains = this._collectActiveChains();

    if (chains.length === 0 && coveragePlanner) {
      chains.push(
        ...sampleOrbitSwathChains(
          this._passStartSec,
          orbitPeriodSec,
          this.orbitConfig,
          this.sensorConfig,
          coveragePlanner,
          this.ellipsoid,
          this.orbitEpoch,
          { markGrid: false },
        ),
      );
    }

    this._destroyPrimitive(this.activePrimitive);
    this.activePrimitive = null;
    this._activeChains = [];
    this._activePoints = [];
    this._activeRolled = false;

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
        cachedChains: chains,
        acquisitionTime: JulianDate.clone(this.passStartTime, new JulianDate()),
        colorBucket: fadeColorBucket(0, this.fadeConfig),
      });
    }

    this._passStartSec = null;
    this.passStartTime = null;
  }

  _buildStripFromChains(chains, color, { asynchronous = false } = {}) {
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
        asynchronous,
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

  updateFade(currentTime, { fastPlayback = false } = {}) {
    const wallNow = performance.now();
    const fadeInterval = fastPlayback
      ? FADE_FAST_PLAYBACK_MS
      : FADE_CHECK_INTERVAL_MS;
    const allowRebuild = wallNow - this._lastFadeWallMs >= fadeInterval;
    if (allowRebuild) this._lastFadeWallMs = wallNow;

    for (let i = this.completedPasses.length - 1; i >= 0; i--) {
      const pass = this.completedPasses[i];
      const ageSec = JulianDate.secondsDifference(
        currentTime,
        pass.acquisitionTime,
      );
      const ageDays = secondsToDays(ageSec);
      const color = swathColorForAge(ageDays, this.fadeConfig);

      if (shouldHideSwath(ageDays, this.fadeConfig)) {
        this._destroyPrimitive(pass.primitive);
        pass.cachedChains = null;
        this.completedPasses.splice(i, 1);
        continue;
      }

      if (!allowRebuild || fastPlayback || !pass.cachedChains?.length) continue;

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
    this._activeChains = [];
    this._activePoints = [];
    this._activeRolled = false;
    this.passStartTime = null;
    this._passStartSec = null;
    this._lastSec = null;
  }

  clear() {
    this.endJumpSim();
    this._destroyPrimitive(this.activePrimitive);
    this.activePrimitive = null;
    for (const pass of this.completedPasses) {
      this._destroyPrimitive(pass.primitive);
      pass.cachedChains = null;
      pass.segments = null;
    }
    this.completedPasses = [];
    this._activeChains = [];
    this._activePoints = [];
    this._activeRolled = false;
    this.passStartTime = null;
    this._passStartSec = null;
    this._lastSec = null;
    this._lastFadeWallMs = 0;
    this._activeDirty = false;
    this._lastActiveRebuildMs = 0;
  }

  get count() {
    let n = this.completedPasses.length;
    if (this.activePrimitive) n += 1;
    return n;
  }
}
