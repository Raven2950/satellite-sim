import * as Cesium from 'cesium';
import { CHINA_BOUNDS } from '../config/satellite.js';

const { Rectangle, Cartesian3, Math: CesiumMath } = Cesium;

const EARTH_RADIUS_M = 6378137;
/** 默认相机到地心距离（约 3.25 倍地球半径，中国居中且可见完整球体） */
export const DEFAULT_GLOBAL_DISTANCE_M = EARTH_RADIUS_M * 3.25;
/** 最远缩放：完整地球 + 边距 */
export const MAX_GLOBAL_DISTANCE_M = EARTH_RADIUS_M * 4.5;
/** 最近缩放 */
export const MIN_GLOBAL_DISTANCE_M = EARTH_RADIUS_M * 1.85;

const EARTH_CENTER = Cartesian3.ZERO;

export function getChinaViewTarget() {
  return Cartesian3.fromDegrees(
    (CHINA_BOUNDS.west + CHINA_BOUNDS.east) / 2,
    (CHINA_BOUNDS.south + CHINA_BOUNDS.north) / 2,
    0,
  );
}

export function computeRegionalChinaCamera() {
  const pad = 3;
  return {
    id: 'regional',
    label: '中国区域',
    rectangle: Rectangle.fromDegrees(
      CHINA_BOUNDS.west - pad,
      CHINA_BOUNDS.south - pad,
      CHINA_BOUNDS.east + pad,
      CHINA_BOUNDS.north + pad,
    ),
  };
}

/**
 * 全球视角：相机位于中国径向外侧，注视地心
 * 可见半球以中国为中心，缩放到最远可看到完整地球
 */
export function computeGlobalChinaCamera() {
  const longitude = (CHINA_BOUNDS.west + CHINA_BOUNDS.east) / 2;
  const latitude = (CHINA_BOUNDS.south + CHINA_BOUNDS.north) / 2;

  return {
    id: 'global',
    label: '全球',
    longitude,
    latitude,
    distanceFromCenter: DEFAULT_GLOBAL_DISTANCE_M,
    /** 微调俯仰，使中国落在画面中央偏下（与参考图一致） */
    pitchOffsetDeg: -12,
  };
}

export function captureCameraSnapshot(viewer, pivot) {
  return {
    position: viewer.camera.position.clone(),
    direction: viewer.camera.direction.clone(),
    up: viewer.camera.up.clone(),
    pivot: pivot.clone(),
  };
}

export function applyCameraSnapshot(viewer, snapshot) {
  viewer.camera.position = snapshot.position.clone();
  viewer.camera.direction = snapshot.direction.clone();
  viewer.camera.up = snapshot.up.clone();
}

export function applyRegionalView(viewer, config) {
  viewer.camera.setView({ destination: config.rectangle });
  return captureCameraSnapshot(viewer, EARTH_CENTER);
}

export function applyGlobalView(viewer, config) {
  const ellipsoid = Cesium.Ellipsoid.WGS84;
  const chinaSurface = Cartesian3.fromDegrees(config.longitude, config.latitude, 0);
  const outward = ellipsoid.geodeticSurfaceNormal(chinaSurface, new Cartesian3());

  const east = Cartesian3.normalize(
    Cartesian3.cross(Cartesian3.UNIT_Z, outward, new Cartesian3()),
    new Cartesian3(),
  );
  const north = Cartesian3.normalize(
    Cartesian3.cross(outward, east, new Cartesian3()),
    new Cartesian3(),
  );

  const pitchRad = CesiumMath.toRadians(config.pitchOffsetDeg ?? -12);
  const camRay = Cartesian3.normalize(
    Cartesian3.add(
      Cartesian3.multiplyByScalar(outward, Math.cos(pitchRad), new Cartesian3()),
      Cartesian3.multiplyByScalar(north, Math.sin(pitchRad), new Cartesian3()),
      new Cartesian3(),
    ),
    new Cartesian3(),
  );

  const dist = config.distanceFromCenter ?? DEFAULT_GLOBAL_DISTANCE_M;
  const camPos = Cartesian3.multiplyByScalar(camRay, dist, new Cartesian3());

  viewer.camera.position = camPos;
  viewer.camera.direction = Cartesian3.normalize(
    Cartesian3.subtract(EARTH_CENTER, camPos, new Cartesian3()),
    new Cartesian3(),
  );
  viewer.camera.up = north;

  return captureCameraSnapshot(viewer, EARTH_CENTER);
}

export function computeAllViewModes() {
  return {
    regional: computeRegionalChinaCamera(),
    global: computeGlobalChinaCamera(),
  };
}
