import * as Cesium from 'cesium';
import { SWATH_SCRUB_RESET_SEC } from '../config/satellite.js';
import {
  computeEcefPosition,
  computeEcefVelocity,
  computeGroundCartesian,
  buildOrbitRingPositions,
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

    this._buildOrbitRing();
    this._buildEntity();
  }

  _secondsSinceEpoch(time) {
    return JulianDate.secondsDifference(time, this.orbitEpoch);
  }

  _buildOrbitRing() {
    const sec = 0;
    this.orbitRingEntity = this.viewer.entities.add({
      id: `${this.config.id}-orbit-ring`,
      polyline: {
        positions: buildOrbitRingPositions(
          this.orbitEpoch,
          this.config.orbit,
          sec,
        ),
        width: 1.5,
        material: Cesium.Color.CYAN.withAlpha(0.45),
        arcType: Cesium.ArcType.NONE,
      },
    });
  }

  _buildEntity() {
    const { id, name, appearance } = this.config;
    const pointColor = Cesium.Color.fromCssColorString(
      appearance?.pointColor ?? '#00FFFF',
    );
    const sec = 0;

    this.entity = this.viewer.entities.add({
      id,
      name,
      position: computeEcefPosition(this.orbitEpoch, sec, this.config.orbit),
      point: {
        pixelSize: appearance?.pointSize ?? 14,
        color: pointColor,
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
      if (!uri) return false;

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

    const imaging = this.coveragePlanner.planImaging(
      currentTime,
      sec,
      nadirGround,
      vel,
      this.ellipsoid,
    );

    const footprintGround = imaging.rollGround ?? imaging.nadirGround;
    const modelCfg = this.config.appearance?.model ?? {};

    this.entity.position = pos;
    this.entity.orientation = computeNadirOrientation(pos, vel, this.ellipsoid, {
      pitch: modelCfg.pitchDeg ?? 0,
      roll: imaging.rollDeg + (modelCfg.rollDeg ?? 0),
      yaw: modelCfg.yawDeg ?? 0,
    });

    this.sensorCone.update(pos, footprintGround, vel);

    if (this.orbitRingEntity?.polyline) {
      this.orbitRingEntity.polyline.positions = buildOrbitRingPositions(
        currentTime,
        this.config.orbit,
        sec,
      );
    }

    this._updateSwath(currentTime, sec, imaging);
    this.swathManager.updateFade(currentTime);
    this.swathCount = this.swathManager.count;
  }

  _updateSwath(currentTime, sec, imaging) {
    if (this._lastFrameSec !== null) {
      const frameAdv = sec - this._lastFrameSec;
      if (frameAdv < 0 || frameAdv > SWATH_SCRUB_RESET_SEC) {
        this.swathManager.resetSampling();
        this.coveragePlanner.reset();
      }
    }
    this._lastFrameSec = sec;

    this.swathManager.updateActivePass(
      currentTime,
      sec,
      this.orbitPeriodSec,
      imaging,
    );
  }

  get coverageCellCount() {
    return this.coveragePlanner.grid.coveredCellCount;
  }

  get currentRollDeg() {
    return this.coveragePlanner.currentRollDeg;
  }

  destroy() {
    const ring = this.viewer.entities.getById(`${this.config.id}-orbit-ring`);
    if (ring) this.viewer.entities.remove(ring);
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
