import * as Cesium from 'cesium';
import {
  EARTH_RADIUS_KM,
  MU_EARTH,
  EARTH_ROTATION_RAD_PER_SEC,
  SIDEREAL_DAY_SEC,
} from '../config/satellite.js';

const {
  Cartesian3,
  JulianDate,
  Matrix3,
  Transforms,
  Simon1994PlanetaryPositions,
  Math: CesiumMath,
  TimeInterval,
} = Cesium;

const J2000 = JulianDate.fromIso8601('2000-01-01T12:00:00Z');

const _scratchSun = new Cartesian3();
const _scratchE1 = new Cartesian3();
const _scratchE2 = new Cartesian3();
const _scratchJulian = new JulianDate();
const _scratchIcrfToFixed = new Matrix3();

export function orbitalPeriodSeconds(altitudeKm) {
  const a = EARTH_RADIUS_KM + altitudeKm;
  return 2 * Math.PI * Math.sqrt((a * a * a) / MU_EARTH);
}

export function meanMotionRadPerSec(altitudeKm) {
  const a = EARTH_RADIUS_KM + altitudeKm;
  return Math.sqrt(MU_EARTH / (a * a * a));
}

/** 太阳单位向量（ECI / ICRF） */
export function getSunUnitEci(julianDate, result) {
  const sun = Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
    julianDate,
    result ?? _scratchSun,
  );
  return Cartesian3.normalize(sun, sun);
}

/** 晨昏轨道平面基向量：轨道面 ⊥ 日地连线，卫星始终在晨昏圈上 */
function buildDawnDuskBasis(sunUnit, e1, e2) {
  let e1Out = Cartesian3.cross(Cartesian3.UNIT_Z, sunUnit, e1);
  if (Cartesian3.magnitudeSquared(e1Out) < 1e-10) {
    e1Out = Cartesian3.cross(Cartesian3.UNIT_X, sunUnit, e1);
  }
  Cartesian3.normalize(e1Out, e1Out);
  const e2Out = Cartesian3.cross(sunUnit, e1Out, e2);
  Cartesian3.normalize(e2Out, e2Out);
  return { e1: e1Out, e2: e2Out };
}

/** 晨昏轨道 ECI 位置（给定幅角 u） */
function computeDawnDuskEciAtU(julianDate, uRad, orbitConfig, result) {
  const radiusM = (EARTH_RADIUS_KM + orbitConfig.altitudeKm) * 1000;
  const sun = getSunUnitEci(julianDate, _scratchSun);
  const { e1, e2 } = buildDawnDuskBasis(sun, _scratchE1, _scratchE2);
  const cosU = Math.cos(uRad);
  const sinU = Math.sin(uRad);
  const x = radiusM * (cosU * e1.x + sinU * e2.x);
  const y = radiusM * (cosU * e1.y + sinU * e2.y);
  const z = radiusM * (cosU * e1.z + sinU * e2.z);
  return Cartesian3.fromElements(x, y, z, result);
}

/** 晨昏轨道 ECI 位置：轨道面法线 ≈ 太阳方向，星下点始终落在晨昏线附近 */
function computeDawnDuskEciPosition(julianDate, secondsSinceEpoch, orbitConfig, result) {
  const n = meanMotionRadPerSec(orbitConfig.altitudeKm);
  const u =
    n * secondsSinceEpoch +
    CesiumMath.toRadians(orbitConfig.initialPhaseDeg ?? 0);
  return computeDawnDuskEciAtU(julianDate, u, orbitConfig, result);
}

/** 由轨道幅角 u（rad）计算 ECI 位置（固定 RAAN 圆轨道，非晨昏） */
export function computeEciFromArgumentOfLatitude(uRad, orbitConfig, result) {
  const { altitudeKm, inclinationDeg, raanDeg = 0 } = orbitConfig;
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

/** 惯性系圆轨道位置（米） */
export function computeEciPosition(julianDate, secondsSinceEpoch, orbitConfig, result) {
  if (orbitConfig.type === 'sun-sync') {
    return computeDawnDuskEciPosition(
      julianDate,
      secondsSinceEpoch,
      orbitConfig,
      result,
    );
  }

  const n = meanMotionRadPerSec(orbitConfig.altitudeKm);
  const u =
    n * secondsSinceEpoch +
    CesiumMath.toRadians(orbitConfig.initialPhaseDeg ?? 0);
  return computeEciFromArgumentOfLatitude(u, orbitConfig, result);
}

/** ECI → ECEF（与 Cesium 太阳/晨昏线同一套 ICRF→Fixed 变换） */
export function eciToEcef(julianDate, eciPosition, result) {
  const out = result ?? new Cartesian3();
  const icrfToFixed = Transforms.computeIcrfToFixedMatrix(
    julianDate,
    _scratchIcrfToFixed,
  );
  if (icrfToFixed) {
    return Matrix3.multiplyByVector(icrfToFixed, eciPosition, out);
  }
  const sec = JulianDate.secondsDifference(julianDate, J2000);
  return eciToEcefFromSeconds(sec, eciPosition, out);
}

/** 预加载 ICRF 数据，避免 computeIcrfToFixedMatrix 返回 undefined */
export async function ensureIcrfReady(startJulian, stopJulian) {
  const interval = new TimeInterval({
    start: startJulian,
    stop: stopJulian,
    isStartIncluded: true,
    isStopIncluded: true,
  });
  await Transforms.preloadIcrfFixed(interval);
}

/** @deprecated 旧接口：无仿真时刻时使用 epoch 秒差近似 */
export function eciToEcefFromSeconds(secondsSinceEpoch, eciPosition, result) {
  const angle = EARTH_ROTATION_RAD_PER_SEC * secondsSinceEpoch;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const x = eciPosition.x * cos - eciPosition.y * sin;
  const y = eciPosition.x * sin + eciPosition.y * cos;
  return Cartesian3.fromElements(x, y, eciPosition.z, result ?? new Cartesian3());
}

/** 地固系显示位置（米） */
export function computeEcefPosition(julianDate, secondsSinceEpoch, orbitConfig, result) {
  const eci = computeEciPosition(julianDate, secondsSinceEpoch, orbitConfig);
  return eciToEcef(julianDate, eci, result);
}

export function computeEcefVelocity(
  julianDate,
  secondsSinceEpoch,
  orbitConfig,
  epsilon = 1,
) {
  const jd1 = JulianDate.addSeconds(julianDate, epsilon, _scratchJulian);
  const p0 = computeEcefPosition(julianDate, secondsSinceEpoch, orbitConfig);
  const p1 = computeEcefPosition(jd1, secondsSinceEpoch + epsilon, orbitConfig);
  return Cartesian3.subtract(p1, p0, new Cartesian3());
}

export function computeGroundCartesian(
  julianDate,
  secondsSinceEpoch,
  orbitConfig,
  sensorConfig,
  ellipsoid,
) {
  const pos = computeEcefPosition(julianDate, secondsSinceEpoch, orbitConfig);
  const carto = ellipsoid.cartesianToCartographic(pos);

  const rollDeg = sensorConfig.rollDeg ?? 0;
  if (Math.abs(rollDeg) < 1e-6) {
    carto.height = 0;
    return ellipsoid.cartographicToCartesian(carto);
  }

  const vel = computeEcefVelocity(julianDate, secondsSinceEpoch, orbitConfig);
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

/** 当前时刻的地固系轨道环 */
export function buildOrbitRingPositions(
  julianDate,
  orbitConfig,
  secondsSinceEpoch,
  segments = 180,
) {
  const n = meanMotionRadPerSec(orbitConfig.altitudeKm);
  const u0 =
    n * secondsSinceEpoch +
    CesiumMath.toRadians(orbitConfig.initialPhaseDeg ?? 0);
  const positions = [];
  for (let k = 0; k <= segments; k++) {
    const u = u0 + (2 * Math.PI * k) / segments;
    const eci =
      orbitConfig.type === 'sun-sync'
        ? computeDawnDuskEciAtU(julianDate, u, orbitConfig)
        : computeEciFromArgumentOfLatitude(u, orbitConfig);
    positions.push(eciToEcef(julianDate, eci, new Cartesian3()));
  }
  return positions;
}

/** 星下点地方太阳时（小时，0–24），用于校验晨昏轨道 */
export function computeLocalSolarTimeHours(julianDate, longitudeRad) {
  const iso = JulianDate.toIso8601(julianDate);
  const timePart = iso.split('T')[1].replace('Z', '').split('.')[0];
  const [hh, mm, ss] = timePart.split(':').map(Number);
  const utcHours = hh + mm / 60 + ss / 3600;
  const lonHours = CesiumMath.toDegrees(longitudeRad) / 15;
  let lst = utcHours + lonHours;
  lst = ((lst % 24) + 24) % 24;
  return lst;
}

/** 每恒星日轨道圈数 */
export function orbitsPerSiderealDay(altitudeKm) {
  return SIDEREAL_DAY_SEC / orbitalPeriodSeconds(altitudeKm);
}

/** 每圈星下点经度西漂（度）≈ 360° / 每日圈数 */
export function groundTrackLongitudeDriftDegPerOrbit(altitudeKm) {
  return 360 / orbitsPerSiderealDay(altitudeKm);
}
