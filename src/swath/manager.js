import * as Cesium from 'cesium';
import {
  sampleOrbitSwathChains,
  sampleGroundTrackPath,
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
  SWATH_INSTANCES_PER_PRIMITIVE,
} from '../config/satellite.js';

const {
  JulianDate,
  GroundPrimitive,
  PerInstanceColorAppearance,
  ClassificationType,
  Cartesian3,
} = Cesium;

import { orbitalPeriodSeconds } from '../orbit/propagate.js';

/** 已完成条带褪色检查最小墙钟间隔（毫秒） */
const FADE_CHECK_INTERVAL_MS = 1500;
/** 倍速播放时历史条带褪色/隐藏检查最小墙钟间隔（毫秒） */
const FADE_FAST_PLAYBACK_MS = 8000;

/** 倍速播放时活跃/封存条带采样密度（与跳转模式解耦） */
const PLAYBACK_SAMPLES_PER_ORBIT = 360;

/**
 * 每圈 ground track 条带
 * - 当前圈：每帧 GroundPrimitive 重建（实时跟随星下点）
 * - 已完成圈：按天褪色 + 节流（避免历史轨迹闪烁）
 * - 离线跳转：先暂存链点，结束后再分批上屏（双星跳转不在过程中创建几何）
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
    this.orbitPeriodSec = orbitalPeriodSeconds(orbitConfig.altitudeKm);

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
    this._pendingPasses = [];
    this._jumpSamplesPerOrbit = 80;
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

  /** 离线跳转开始前设置目标时刻与采样密度 */
  beginJumpSim(finalTime, { samplesPerOrbit = 80 } = {}) {
    this._jumpFinalTime = JulianDate.clone(finalTime, new JulianDate());
    this._pendingPasses = [];
    this._jumpSamplesPerOrbit = samplesPerOrbit;
  }

  endJumpSim() {
    this._jumpFinalTime = null;
    this._pendingPasses = [];
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

  appendSwathSample(
    swathGround,
    { fastPlayback = false, sec = null, deferRebuild = false } = {},
  ) {
    if (!swathGround) return;
    if (sec !== null) this._lastSec = sec;
    if (!fastPlayback || this._jumpFinalTime) {
      this._advanceActivePoints(swathGround, this._activePoints);
    }
    if (!deferRebuild) {
      this._rebuildActiveChains({ fastPlayback });
    }
  }

  rebuildActiveChains({ fastPlayback = false } = {}) {
    this._rebuildActiveChains({ fastPlayback });
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

  _rebuildActiveChains({ fastPlayback = false } = {}) {
    if (
      fastPlayback &&
      !this._jumpFinalTime &&
      this._passStartSec !== null &&
      this._lastSec !== null &&
      this._lastSec > this._passStartSec
    ) {
      const endSec = Math.min(
        this._lastSec,
        this._passStartSec + this.orbitPeriodSec,
      );
      const chains = sampleGroundTrackPath(
        this._passStartSec,
        endSec,
        this.orbitPeriodSec,
        this.orbitConfig,
        { ...this.sensorConfig, rollDeg: 0 },
        this.ellipsoid,
        this.orbitEpoch,
        PLAYBACK_SAMPLES_PER_ORBIT,
      );
      const merged = stitchAdjacentChains(chains, this.ellipsoid);
      if (merged.length === 0) return;
      this._rebuildActivePrimitive(merged);
      return;
    }

    if (this._activePoints.length < 2) return;
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

  /** 离线快进：只采样链点暂存，不创建 GroundPrimitive */
  simulateOrbitPass(passStartSec, orbitPeriodSec, passStartTime, coveragePlanner) {
    if (!this._jumpFinalTime) {
      console.warn('simulateOrbitPass called outside jump sim');
      return;
    }

    const ageSec = JulianDate.secondsDifference(
      this._jumpFinalTime,
      passStartTime,
    );
    const ageDays = secondsToDays(ageSec);

    if (shouldHideSwath(ageDays, this.fadeConfig)) {
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
      { markGrid: false, samplesPerOrbit: this._jumpSamplesPerOrbit },
    );

    if (chains.length === 0) return;

    this._pendingPasses.push({
      chains,
      acquisitionTime: JulianDate.clone(passStartTime, new JulianDate()),
    });
  }

  /** 跳转过程中周期性 flush pending，避免链点无限累积 */
  async flushPendingPartial() {
    if (!this._pendingPasses.length || !this._jumpFinalTime) return;
    await this._commitPendingPasses(this._jumpFinalTime);
  }

  /** 跳转采样结束后：flush 剩余 pending */
  async flushPendingPasses(finalTime, { onProgress } = {}) {
    if (this._pendingPasses.length === 0) {
      onProgress?.(1);
      return;
    }
    await this._commitPendingPasses(finalTime, { onProgress });
    onProgress?.(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async _commitPendingPasses(finalTime, { onProgress } = {}) {
    const pending = this._pendingPasses;
    this._pendingPasses = [];
    if (pending.length === 0) return;

    let batchChains = [];
    let batchInstances = 0;
    let batchAcq = null;
    let batchBucket = null;

    const flushBatch = () => {
      if (batchChains.length === 0) return;
      const ageSec = JulianDate.secondsDifference(finalTime, batchAcq);
      const ageDays = secondsToDays(ageSec);
      const color = swathColorForAge(ageDays, this.fadeConfig);
      const primitive = this._buildStripFromChains(batchChains, color);
      if (primitive) {
        this.viewer.scene.groundPrimitives.add(primitive);
        this.completedPasses.push({
          primitive,
          cachedChains: null,
          acquisitionTime: JulianDate.clone(batchAcq, new JulianDate()),
          colorBucket: batchBucket,
        });
      }
      batchChains = [];
      batchInstances = 0;
      batchAcq = null;
      batchBucket = null;
    };

    for (let i = 0; i < pending.length; i++) {
      const pass = pending[i];
      const ageSec = JulianDate.secondsDifference(finalTime, pass.acquisitionTime);
      const ageDays = secondsToDays(ageSec);

      if (shouldHideSwath(ageDays, this.fadeConfig)) {
        pass.chains = null;
        continue;
      }

      const bucket = fadeColorBucket(ageDays, this.fadeConfig);
      const added = estimateStripInstances(pass.chains);

      if (
        batchInstances > 0 &&
        (batchBucket !== bucket ||
          batchInstances + added > SWATH_INSTANCES_PER_PRIMITIVE)
      ) {
        flushBatch();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      if (batchAcq === null) batchAcq = pass.acquisitionTime;
      batchBucket = bucket;
      batchChains.push(...pass.chains);
      batchInstances += added;
      pass.chains = null;

      if (i > 0 && i % 25 === 0) {
        onProgress?.((i + 1) / pending.length);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    flushBatch();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  finalizePass(orbitPeriodSec, coveragePlanner) {
    if (this._passStartSec === null) return;

    const passStartSec = this._passStartSec;
    const passStartTime = JulianDate.clone(this.passStartTime, new JulianDate());

    /** 倍速/实时：整圈重采样，避免 99.5% 截断与稀疏追点造成断点（跳转不走此分支） */
    let chains;
    if (!this._jumpFinalTime && coveragePlanner) {
      chains = sampleOrbitSwathChains(
        passStartSec,
        orbitPeriodSec,
        this.orbitConfig,
        this.sensorConfig,
        coveragePlanner,
        this.ellipsoid,
        this.orbitEpoch,
        { markGrid: false, samplesPerOrbit: PLAYBACK_SAMPLES_PER_ORBIT },
      );
    } else {
      chains = this._collectActiveChains();
      if (chains.length === 0 && coveragePlanner) {
        chains.push(
          ...sampleOrbitSwathChains(
            passStartSec,
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
        acquisitionTime: passStartTime,
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
    const allowCheck = wallNow - this._lastFadeWallMs >= fadeInterval;
    if (allowCheck) this._lastFadeWallMs = wallNow;
    if (!allowCheck) return;

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

      if (fastPlayback || !pass.cachedChains?.length) continue;

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
    }
    this.completedPasses = [];
    this._activeChains = [];
    this._activePoints = [];
    this._activeRolled = false;
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
