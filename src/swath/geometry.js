import * as Cesium from 'cesium';
import {
  computeGroundCartesian,
  computeEcefVelocity,
} from '../orbit/propagate.js';

const { Cartesian3, JulianDate } = Cesium;

const _scratchJulian = new JulianDate();

/**
 * 在两点之间生成 swathWidth 宽的地面扫描条带四边形
 */
export function buildSwathQuad(p0, p1, halfWidthM, ellipsoid) {
  const dir = Cartesian3.subtract(p1, p0, new Cartesian3());
  if (Cartesian3.magnitudeSquared(dir) < 1) return null;
  Cartesian3.normalize(dir, dir);

  const mid = Cartesian3.midpoint(p0, p1, new Cartesian3());
  const up = ellipsoid.geodeticSurfaceNormal(mid, new Cartesian3());
  const cross = Cartesian3.normalize(
    Cartesian3.cross(up, dir, new Cartesian3()),
    new Cartesian3(),
  );
  const offset = Cartesian3.multiplyByScalar(cross, halfWidthM, new Cartesian3());

  const c0a = Cartesian3.add(p0, offset, new Cartesian3());
  const c0b = Cartesian3.subtract(p0, offset, new Cartesian3());
  const c1a = Cartesian3.add(p1, offset, new Cartesian3());
  const c1b = Cartesian3.subtract(p1, offset, new Cartesian3());

  return [c0a, c1a, c1b, c0b];
}

/** 相邻点超过此距离视为不连续（避免跨球面拉直线） */
const DISCONTINUITY_M = 4_000_000;

/**
 * 按轨道时间密集采样一整段 ground track（大圆地面轨迹）
 */
export function sampleGroundTrackPath(
  startSec,
  endSec,
  orbitPeriodSec,
  orbitConfig,
  sensorConfig,
  ellipsoid,
  orbitEpoch,
  samplesPerOrbit = 360,
) {
  if (endSec < startSec) return [];

  const stepSec = orbitPeriodSec / samplesPerOrbit;
  const effectiveEnd = Math.max(endSec, startSec + stepSec);

  const points = [];
  for (let t = startSec; t <= effectiveEnd + stepSec * 0.01; t += stepSec) {
    const sampleT = Math.min(t, effectiveEnd);
    const sampleJulian = JulianDate.addSeconds(
      orbitEpoch,
      sampleT,
      _scratchJulian,
    );
    points.push(
      computeGroundCartesian(
        sampleJulian,
        sampleT,
        orbitConfig,
        sensorConfig,
        ellipsoid,
      ),
    );
    if (sampleT >= effectiveEnd) break;
  }

  return _splitAtDiscontinuities(points);
}

function _splitAtDiscontinuities(points) {
  if (points.length < 2) return [points];

  const chains = [];
  let chain = [Cartesian3.clone(points[0])];

  for (let i = 1; i < points.length; i++) {
    const prev = chain[chain.length - 1];
    const cur = points[i];
    if (Cartesian3.distance(prev, cur) > DISCONTINUITY_M) {
      if (chain.length >= 2) chains.push(chain);
      chain = [Cartesian3.clone(cur)];
    } else {
      chain.push(Cartesian3.clone(cur));
    }
  }
  if (chain.length >= 2) chains.push(chain);
  return chains;
}

/**
 * 采样一整圈成像轨迹（对地 + 缺口补扫偏转），返回可绘制条带链
 * @param {boolean} [options.markGrid=true] true 时写入覆盖栅格（跳转离线）；false 仅几何（finalize 重采样）
 */
export function sampleOrbitSwathChains(
  passStartSec,
  orbitPeriodSec,
  orbitConfig,
  sensorConfig,
  coveragePlanner,
  ellipsoid,
  orbitEpoch,
  { samplesPerOrbit = 360, markGrid = true } = {},
) {
  const nadirSensor = { ...sensorConfig, rollDeg: 0 };
  const stepSec = orbitPeriodSec / samplesPerOrbit;
  const endSec = passStartSec + orbitPeriodSec;
  const nadirPoints = [];
  const rollPoints = [];

  for (let t = passStartSec; t <= endSec + stepSec * 0.01; t += stepSec) {
    const sec = Math.min(t, endSec);
    const jd = JulianDate.addSeconds(orbitEpoch, sec, _scratchJulian);
    const vel = computeEcefVelocity(jd, sec, orbitConfig);
    const nadir = computeGroundCartesian(
      jd,
      sec,
      orbitConfig,
      nadirSensor,
      ellipsoid,
    );

    let rollGround = null;
    if (markGrid) {
      const plan = coveragePlanner.planImaging(jd, sec, nadir, vel, ellipsoid);
      rollGround = plan.rollGround;
    } else {
      const sample = coveragePlanner.sampleSwathPoints(
        jd,
        sec,
        nadir,
        vel,
        ellipsoid,
      );
      rollGround = sample.rollGround;
    }

    nadirPoints.push(nadir);
    if (rollGround) {
      rollPoints.push(rollGround);
    }
    if (sec >= endSec) break;
  }

  return [
    ..._splitAtDiscontinuities(nadirPoints),
    ..._splitAtDiscontinuities(rollPoints),
  ];
}

/** 将多段 ground chain 合并为条带 primitive 所需点列 */
export function chainsToStripInstances(chains, halfWidthM, ellipsoid, color) {
  const {
    GeometryInstance,
    PolygonGeometry,
    PerInstanceColorAppearance,
    ColorGeometryInstanceAttribute,
  } = Cesium;

  const instances = [];
  for (const chain of chains) {
    for (let i = 0; i < chain.length - 1; i++) {
      const quad = buildSwathQuad(
        chain[i],
        chain[i + 1],
        halfWidthM,
        ellipsoid,
      );
      if (!quad) continue;
      instances.push(
        new GeometryInstance({
          geometry: PolygonGeometry.fromPositions({
            positions: quad,
            vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: {
            color: ColorGeometryInstanceAttribute.fromColor(color),
          },
        }),
      );
    }
  }
  return instances;
}
