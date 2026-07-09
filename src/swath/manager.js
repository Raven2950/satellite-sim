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

  /** 离线跳转开始前设置目标时刻（用于计算褪色） */
  beginJumpSim(finalTime) {
    this._jumpFinalTime = JulianDate.clone(finalTime, new JulianDate());
    this._pendingPasses = [];
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

  appendSwathSample(swathGround) {
    if (!swathGround) return;
    this._advanceActivePoints(swathGround, this._activePoints);
    this._rebuildActiveChains();
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

  _rebuildActiveChains() {
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
      sampleOrbitCoveragePass(
        passStartSec,
        orbitPeriodSec,
        this.orbitConfig,
        this.sensorConfig,
        coveragePlanner,
        this.ellipsoid,
        this.orbitEpoch,
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
      { markGrid: true, samplesPerOrbit: JUMP_SAMPLES_PER_ORBIT },
    );

    if (chains.length === 0) return;

    this._pendingPasses.push({
      chains,
      acquisitionTime: JulianDate.clone(passStartTime, new JulianDate()),
    });
  }

  /** 跳转采样结束后：按褪色分桶合并并分批上屏 */
  async flushPendingPasses(finalTime, { onProgress } = {}) {
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
    onProgress?.(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
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

      if (shouldHideSwath(ageDays, this.fadeConfig)) {
        this._destroyPrimitive(pass.primitive);
        pass.cachedChains = null;
        this.completedPasses.splice(i, 1);
        continue;
      }

      if (!allowRebuild || !pass.cachedChains?.length) continue;

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
