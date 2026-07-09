import * as Cesium from 'cesium';
import {
  computeEcefPosition,
  computeEcefVelocity,
  computeGroundCartesian,
  orbitalPeriodSeconds,
} from '../orbit/propagate.js';
import { CoveragePlanner } from '../sensor/coveragePlanner.js';
import { SwathManager } from '../swath/manager.js';
import { resolveSatelliteModelUri } from './modelLoader.js';
import { SensorCone, computeNadirOrientation } from './sensorCone.js';

const { JulianDate } = Cesium;

export class Satellite {
  constructor(viewer, config, orbitEpoch) {
    this.viewer = viewer;
    this.config = config;
    this.orbitEpoch = orbitEpoch;
    this.ellipsoid = viewer.scene.globe.ellipsoid;
    this.orbitPeriodSec = orbitalPeriodSeconds(config.orbit.altitudeKm);

    this.coveragePlanner = new CoveragePlanner(config.orbit, config.sensor);

    this.swathManager = new SwathManager(
      viewer,
      config.orbit,
      config.sensor,
      config.fade,
      orbitEpoch,
    );
    this.swathManager.setCoveragePlanner(this.coveragePlanner);

    this._lastFrameSec = null;
    this.swathCount = 0;
    this._modelLoadPromise = null;

    const halfWidthM = (config.sensor.swathWidthKm * 1000) / 2;
    const coneOpts = config.appearance?.sensorCone ?? {};
    const footprintScale = coneOpts.footprintScale ?? 1;
    this.sensorCone = new SensorCone(viewer, config.id, {
      halfWidthM: halfWidthM * footprintScale,
      alongHalfM: halfWidthM * footprintScale,
      ...coneOpts,
    });

    this._buildEntity();
  }

  _secondsSinceEpoch(time) {
    return JulianDate.secondsDifference(time, this.orbitEpoch);
  }

  _buildEntity() {
    const { id, name, appearance } = this.config;
    const sec = 0;

    this.entity = this.viewer.entities.add({
      id,
      name,
      position: computeEcefPosition(this.orbitEpoch, sec, this.config.orbit),
      point: {
        show: false,
        pixelSize: appearance?.pointSize ?? 14,
        color: Cesium.Color.fromCssColorString(
          appearance?.pointColor ?? '#00FFFF',
        ),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  loadModel() {
    if (this._modelLoadPromise) return this._modelLoadPromise;

    this._modelLoadPromise = (async () => {
      const modelCfg = this.config.appearance?.model ?? {};
      const uri = await resolveSatelliteModelUri(modelCfg);
      if (!uri) {
        if (this.entity.point) this.entity.point.show = true;
        return false;
      }

      try {
        this.entity.model = {
          uri,
          scale: modelCfg.scale ?? 1,
          minimumPixelSize: modelCfg.minimumPixelSize ?? 42,
          maximumPixelSize: modelCfg.maximumPixelSize ?? 42,
        };
        if (this.entity.point) this.entity.point.show = false;
        this.viewer.scene.requestRender();
        return true;
      } catch (err) {
        console.warn('Satellite model failed:', err);
        if (this.entity.point) this.entity.point.show = true;
        return false;
      }
    })();

    return this._modelLoadPromise;
  }

  update(currentTime) {
    const sec = this._secondsSinceEpoch(currentTime);
    const pos = computeEcefPosition(currentTime, sec, this.config.orbit);
    const vel = computeEcefVelocity(currentTime, sec, this.config.orbit);

    const nadirGround = computeGroundCartesian(
      currentTime,
      sec,
      this.config.orbit,
      { ...this.config.sensor, rollDeg: 0 },
      this.ellipsoid,
    );

    if (this._lastFrameSec !== null && sec < this._lastFrameSec) {
      this.swathManager.resetSampling();
      this.coveragePlanner.reset();
    }

    const denseStep = this.orbitPeriodSec / 360;
    let imaging;

    if (
      this._lastFrameSec !== null &&
      sec - this._lastFrameSec > denseStep * 2
    ) {
      imaging = this._denseImagingAdvance(this._lastFrameSec, sec);
    } else {
      this.swathManager.preparePassFrame(
        currentTime,
        sec,
        this.orbitPeriodSec,
      );
      imaging = this.coveragePlanner.planImaging(
        currentTime,
        sec,
        nadirGround,
        vel,
        this.ellipsoid,
      );
      this.swathManager.appendSwathSample(
        imaging.swathGround,
        imaging.isRolled,
        imaging.nadirGround,
      );
      this.swathManager._lastSec = sec;
    }

    const modelCfg = this.config.appearance?.model ?? {};

    this.entity.position = pos;
    this.entity.orientation = computeNadirOrientation(pos, vel, this.ellipsoid, {
      pitch: modelCfg.pitchDeg ?? 0,
      roll: modelCfg.rollDeg ?? 0,
      yaw: modelCfg.yawDeg ?? 0,
    });

    this.sensorCone.update(pos, nadirGround, vel);
    this._lastFrameSec = sec;

    this.swathManager.updateFade(currentTime);
    this.swathCount = this.swathManager.count;
  }

  /** 倍速大步长时稠密补采样，避免当前圈条带拉成跨球面大三角 */
  _denseImagingAdvance(fromSec, toSec) {
    const stepSec = this.orbitPeriodSec / 360;
    const scratch = new JulianDate();
    let lastImaging = null;

    for (let t = fromSec + stepSec; t <= toSec + stepSec * 0.001; t += stepSec) {
      const sec = Math.min(t, toSec);
      const jd = JulianDate.addSeconds(this.orbitEpoch, sec, scratch);
      const vel = computeEcefVelocity(jd, sec, this.config.orbit);
      const nadir = computeGroundCartesian(
        jd,
        sec,
        this.config.orbit,
        { ...this.config.sensor, rollDeg: 0 },
        this.ellipsoid,
      );

      this.swathManager.preparePassFrame(jd, sec, this.orbitPeriodSec);
      lastImaging = this.coveragePlanner.planImaging(
        jd,
        sec,
        nadir,
        vel,
        this.ellipsoid,
      );
      this.swathManager.appendSwathSample(
        lastImaging.swathGround,
        lastImaging.isRolled,
        lastImaging.nadirGround,
      );
      if (sec >= toSec) break;
    }

    this.swathManager._lastSec = toSec;

    return (
      lastImaging ?? {
        nadirGround: null,
        swathGround: null,
        rollDeg: this.coveragePlanner.currentRollDeg,
        isRolled: false,
      }
    );
  }

  /**
   * 离线快进到 anchor 起第 targetSimSec 秒（按整圈推进，不触发实时渲染）
   */
  async simulateToSec(anchor, targetSimSec, { onProgress } = {}) {
    if (targetSimSec <= 0) return;

    const initialSec = this._secondsSinceEpoch(anchor);
    const orbitPeriodSec = this.orbitPeriodSec;
    const orbitCount = Math.floor(targetSimSec / orbitPeriodSec);
    if (orbitCount <= 0) return;

    const scratch = new JulianDate();

    for (let i = 0; i < orbitCount; i++) {
      const passStartSec = initialSec + i * orbitPeriodSec;
      const simElapsed = i * orbitPeriodSec;
      const passStartTime = JulianDate.addSeconds(anchor, simElapsed, scratch);

      this.swathManager.simulateOrbitPass(
        passStartSec,
        orbitPeriodSec,
        passStartTime,
        this.coveragePlanner,
      );

      if (i % 15 === 0) {
        onProgress?.(i / orbitCount);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    const finalTime = JulianDate.addSeconds(anchor, targetSimSec, scratch);
    await this.swathManager.flushPendingPasses(finalTime, {
      onProgress: (fraction) => onProgress?.(0.9 + fraction * 0.1),
    });

    const beginSec = initialSec + orbitCount * orbitPeriodSec;
    const beginTime = JulianDate.addSeconds(
      anchor,
      orbitCount * orbitPeriodSec,
      scratch,
    );
    this.swathManager.beginPass(beginTime, beginSec);
    this._lastFrameSec = initialSec + targetSimSec;
    this.swathCount = this.swathManager.count;
  }

  get coverageCellCount() {
    return this.coveragePlanner.coveredCellCount;
  }

  get currentRollDeg() {
    return this.coveragePlanner.currentRollDeg;
  }

  destroy() {
    if (this.entity) {
      this.viewer.entities.remove(this.entity);
      this.entity = null;
    }
    this.sensorCone?.destroy();
    this.swathManager.clear();
    this.coveragePlanner.reset();
    this._lastFrameSec = null;
    this.swathCount = 0;
  }
}
