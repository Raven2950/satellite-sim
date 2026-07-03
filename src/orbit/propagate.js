import * as Cesium from 'cesium';
import {
  EARTH_RADIUS_KM,
  MU_EARTH,
  EARTH_ROTATION_RAD_PER_SEC,
  SIDEREAL_DAY_SEC,
} from '../config/satellite.js';

const { Cartesian3, Math: CesiumMath } = Cesium;

export function orbitalPeriodSeconds(altitudeKm) {
  const a = EARTH_RADIUS_KM + altitudeKm;
  return 2 * Math.PI * Math.sqrt((a * a * a) / MU_EARTH);
}

export function meanMotionRadPerSec(altitudeKm) {
  const a = EARTH_RADIUS_KM + altitudeKm;
  return Math.sqrt(MU_EARTH / (a * a * a));
}

/** 由轨道幅角 u（rad）计算 ECI 位置 */
export function computeEciFromArgumentOfLatitude(uRad, orbitConfig, result) {
  const { altitudeKm, inclinationDeg, raanDeg } = orbitConfig;
  const radiusM = (EARTH_RADIUS_KM + altitudeKm) * 1000;

  const i = CesiumMath.toRadians(inclinationDeg);
  const raan = CesiumMath.toRadians(raanDeg);

  const xOrb = radiusM * Math.cos(uRad);
  const yOrb = radiusM * Math.sin(uRad);

  const cosRaan = Math.cos(raan);
  const sinRaan = Math.sin(raan);
  const cosI = Math.cos(i);
  const sinI = Math.sin(i);

  const x = cosRaan * xOrb - sinRaan * cosI * yOrb;
  const y = sinRaan * xOrb + cosRaan * cosI * yOrb;
  const z = sinI * yOrb;

  return Cartesian3.fromElements(x, y, z, result);
}

/** 惯性系（ECI）圆轨道位置（米）——轨道平面相对恒星固定 */
export function computeEciPosition(secondsSinceEpoch, orbitConfig, result) {
  const n = meanMotionRadPerSec(orbitConfig.altitudeKm);
  const u =
    n * secondsSinceEpoch +
    CesiumMath.toRadians(orbitConfig.initialPhaseDeg);
  return computeEciFromArgumentOfLatitude(u, orbitConfig, result);
}

/**
 * ECI → ECEF：地球自转（恒星日角速度）
 * 贴图固定不动时，星下点每圈向西漂移约 360°/N_orbits_per_day
 */
export function eciToEcef(secondsSinceEpoch, eciPosition, result) {
  const angle = EARTH_ROTATION_RAD_PER_SEC * secondsSinceEpoch;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const x = eciPosition.x * cos - eciPosition.y * sin;
  const y = eciPosition.x * sin + eciPosition.y * cos;
  return Cartesian3.fromElements(x, y, eciPosition.z, result);
}

/**
 * 地固系显示位置（米）
 * 物理：惯性圆轨道 + 地球自转 → 固定贴图下星下点逐圈西漂
 */
export function computeEcefPosition(secondsSinceEpoch, orbitConfig, result) {
  const eci = computeEciPosition(secondsSinceEpoch, orbitConfig);
  return eciToEcef(secondsSinceEpoch, eci, result);
}

export function computeEcefVelocity(secondsSinceEpoch, orbitConfig, epsilon = 1) {
  const p0 = computeEcefPosition(secondsSinceEpoch, orbitConfig);
  const p1 = computeEcefPosition(secondsSinceEpoch + epsilon, orbitConfig);
  return Cartesian3.subtract(p1, p0, new Cartesian3());
}

export function computeGroundCartesian(
  secondsSinceEpoch,
  orbitConfig,
  sensorConfig,
  ellipsoid,
) {
  const pos = computeEcefPosition(secondsSinceEpoch, orbitConfig);
  const carto = ellipsoid.cartesianToCartographic(pos);

  const rollDeg = sensorConfig.rollDeg ?? 0;
  if (Math.abs(rollDeg) < 1e-6) {
    carto.height = 0;
    return ellipsoid.cartographicToCartesian(carto);
  }

  const vel = computeEcefVelocity(secondsSinceEpoch, orbitConfig);
  const surface = ellipsoid.cartographicToCartesian(carto);
  const up = ellipsoid.geodeticSurfaceNormal(surface, new Cartesian3());
  const crossTrack = Cartesian3.normalize(
    Cartesian3.cross(vel, up, new Cartesian3()),
    new Cartesian3(),
  );
  const offsetM =
    orbitConfig.altitudeKm * 1000 * Math.tan(CesiumMath.toRadians(rollDeg));
  const offsetSurface = Cartesian3.add(
    surface,
    Cartesian3.multiplyByScalar(crossTrack, offsetM, new Cartesian3()),
    new Cartesian3(),
  );
  const groundCarto = ellipsoid.cartesianToCartographic(offsetSurface);
  groundCarto.height = 0;
  return ellipsoid.cartographicToCartesian(groundCarto);
}

export function buildAvailabilityInterval(startTime, stopTime) {
  const { TimeInterval, TimeIntervalCollection } = Cesium;
  return new TimeIntervalCollection([
    new TimeInterval({
      start: startTime,
      stop: stopTime,
      isStartIncluded: true,
      isStopIncluded: true,
    }),
  ]);
}

/**
 * 当前时刻的地固系轨道环
 * 以卫星当前相位为中心采样整圈，保证卫星始终落在环上
 */
export function buildOrbitRingPositions(
  orbitConfig,
  secondsSinceEpoch,
  segments = 180,
) {
  const n = meanMotionRadPerSec(orbitConfig.altitudeKm);
  const u0 =
    n * secondsSinceEpoch +
    CesiumMath.toRadians(orbitConfig.initialPhaseDeg);
  const positions = [];
  for (let k = 0; k <= segments; k++) {
    const u = u0 + (2 * Math.PI * k) / segments;
    const eci = computeEciFromArgumentOfLatitude(u, orbitConfig);
    positions.push(eciToEcef(secondsSinceEpoch, eci, new Cartesian3()));
  }
  return positions;
}

/** 每恒星日轨道圈数 */
export function orbitsPerSiderealDay(altitudeKm) {
  return SIDEREAL_DAY_SEC / orbitalPeriodSeconds(altitudeKm);
}

/** 每圈星下点经度西漂（度）≈ 360° / 每日圈数 */
export function groundTrackLongitudeDriftDegPerOrbit(altitudeKm) {
  return 360 / orbitsPerSiderealDay(altitudeKm);
}
