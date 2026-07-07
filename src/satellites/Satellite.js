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

/** 时间大跳时按轨补采样，而非清空当前圈 */
const CATCHUP_ORBIT_FRACTION = 0.25;

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

  _sampleImagingAt(sec, julianDate) {
    const nadirGround = computeGroundCartesian(
      julianDate,
      sec,
      this.config.orbit,
      { ...this.config.sensor, rollDeg: 0 },
      this.ellipsoid,
    );
    const vel = computeEcefVelocity(julianDate, sec, this.config.orbit);
    return this.coveragePlanner.planImaging(
      julianDate,
      sec,
      nadirGround,
      vel,
      this.ellipsoid,
    );
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

    this._handleTimeJump(currentTime, sec);

    const nadirGround = computeGroundCartesian(
      currentTime,
      sec,
      this.config.orbit,
      { ...this.config.sensor, rollDeg: 0 },
      this.ellipsoid,
    );

    const imaging = this.coveragePlanner.planImaging(
      currentTime,
      sec,
      nadirGround,
      vel,
      this.ellipsoid,
    );

    const modelCfg = this.config.appearance?.model ?? {};

    this.entity.position = pos;
    this.entity.orientation = computeNadirOrientation(pos, vel, this.ellipsoid, {
      pitch: modelCfg.pitchDeg ?? 0,
      roll: imaging.rollDeg + (modelCfg.rollDeg ?? 0),
      yaw: modelCfg.yawDeg ?? 0,
    });

    // 绿色视场锥始终对地，与偏转补扫条带解耦
    this.sensorCone.update(pos, nadirGround, vel);

    this.swathManager.updateActivePass(
      currentTime,
      sec,
      this.orbitPeriodSec,
      imaging,
    );
    this.swathManager.updateFade(currentTime);
    this.swathCount = this.swathManager.count;
    this._lastFrameSec = sec;
  }

  /** 仅时间回退时重置；前进大跳则固化当前圈并补采样 */
  _handleTimeJump(currentTime, sec) {
    if (this._lastFrameSec === null) {
      this._lastFrameSec = sec;
      return;
    }

    const frameAdv = sec - this._lastFrameSec;
    if (frameAdv < 0) {
      this.swathManager.resetSampling();
      this.coveragePlanner.reset();
      return;
    }

    const catchupThreshold = this.orbitPeriodSec * CATCHUP_ORBIT_FRACTION;
    if (frameAdv <= catchupThreshold) return;

    this.swathManager.finalizePass();

    const sampleImaging = (sampleSec) => {
      const jd = JulianDate.addSeconds(
        this.orbitEpoch,
        sampleSec,
        new JulianDate(),
      );
      return this._sampleImagingAt(sampleSec, jd);
    };

    this.swathManager.resamplePassRange(
      this._lastFrameSec,
      sec,
      this.orbitPeriodSec,
      sampleImaging,
    );

    this.swathManager.beginPass(currentTime, sec);
  }

  get coverageCellCount() {
    return this.coveragePlanner.grid.coveredCellCount;
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
