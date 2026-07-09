import * as Cesium from 'cesium';
import {
  computeGroundCartesian,
  computeEcefVelocity,
} from '../orbit/propagate.js';
import { swathColorForAge, secondsToDays } from './fade.js';

const { Cartesian3, JulianDate, EllipsoidGeodesic } = Cesium;

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
  if (points.length < 2) return points.length ? [points] : [];

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

/** 偏转/切段间距小于此值时自动桥接（米） */
const STITCH_MAX_GAP_M = 600_000;

/** 对地↔偏转切换：沿椭球大地线密采样过渡，保证条带中心线连续 */
export function bridgeSwathTransition(fromGround, toGround, ellipsoid, steps) {
  if (Cartesian3.distance(fromGround, toGround) < 1) {
    return [Cartesian3.clone(fromGround)];
  }

  const c0 = ellipsoid.cartesianToCartographic(fromGround);
  const c1 = ellipsoid.cartesianToCartographic(toGround);
  const geodesic = new EllipsoidGeodesic(c0, c1, ellipsoid);
  const surfaceDist = geodesic.surfaceDistance;
  const stepCount =
    steps ??
    Math.max(12, Math.min(64, Math.ceil(surfaceDist / 2500)));

  const points = [];
  for (let i = 0; i <= stepCount; i++) {
    const carto = geodesic.interpolateUsingSurfaceDistance(
      (surfaceDist * i) / stepCount,
    );
    points.push(ellipsoid.cartographicToCartesian(carto));
  }
  return points;
}

/** 将过渡点追加到链中（跳过与末点重合的首点） */
export function appendBridgeIntoChain(chain, fromGround, toGround, ellipsoid) {
  const bridge = bridgeSwathTransition(fromGround, toGround, ellipsoid);
  for (let i = 1; i < bridge.length; i++) {
    const p = bridge[i];
    const last = chain[chain.length - 1];
    if (!last || Cartesian3.distanceSquared(last, p) > 0.25) {
      chain.push(Cartesian3.clone(p));
    }
  }
}

function _pushPointDedup(chain, point) {
  const last = chain[chain.length - 1];
  if (!last || Cartesian3.distanceSquared(last, point) > 0.25) {
    chain.push(Cartesian3.clone(point));
  }
}

/**
 * 合并相邻链：小间隙插入大地线桥，大间隙保留（如反子午线）
 */
export function stitchAdjacentChains(chains, ellipsoid, maxGapM = STITCH_MAX_GAP_M) {
  if (!chains.length) return [];
  const valid = chains.filter((c) => c.length >= 2);
  if (valid.length <= 1) return valid;

  const merged = [valid[0].map((p) => Cartesian3.clone(p))];

  for (let i = 1; i < valid.length; i++) {
    const next = valid[i];
    const current = merged[merged.length - 1];
    const end = current[current.length - 1];
    const start = next[0];
    const gap = Cartesian3.distance(end, start);

    if (gap <= maxGapM) {
      appendBridgeIntoChain(current, end, start, ellipsoid);
      for (let j = 1; j < next.length; j++) {
        _pushPointDedup(current, next[j]);
      }
    } else {
      merged.push(next.map((p) => Cartesian3.clone(p)));
    }
  }

  return merged;
}

/**
 * 采样一整圈白痕链（始终沿星下点；偏转仅写入覆盖栅格）
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

  coveragePlanner.beginPass();

  const chain = [];

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

    coveragePlanner.planImaging(jd, sec, nadir, vel, ellipsoid, {
      markGrid,
    });

    _pushPointDedup(chain, nadir);

    if (sec >= endSec) break;
  }

  if (chain.length < 2) return [];

  return _splitAtDiscontinuities(chain);
}

/** 仅更新覆盖栅格（跳转时对将隐藏的圈用稀疏采样） */
export function sampleOrbitCoveragePass(
  passStartSec,
  orbitPeriodSec,
  orbitConfig,
  sensorConfig,
  coveragePlanner,
  ellipsoid,
  orbitEpoch,
  { samplesPerOrbit = 72 } = {},
) {
  const nadirSensor = { ...sensorConfig, rollDeg: 0 };
  const stepSec = orbitPeriodSec / samplesPerOrbit;
  const endSec = passStartSec + orbitPeriodSec;

  coveragePlanner.beginPass();

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
    coveragePlanner.planImaging(jd, sec, nadir, vel, ellipsoid, {
      markGrid: true,
    });
    if (sec >= endSec) break;
  }
}

export function estimateStripInstances(chains) {
  let n = 0;
  for (const chain of chains) {
    if (chain.length >= 2) n += chain.length - 1;
  }
  return n;
}

/** 将多段 ground chain 合并为条带 primitive 所需点列 */
export function chainsToStripInstances(chains, halfWidthM, ellipsoid, color) {
  const {
    GeometryInstance,
    PolygonGeometry,
    PerInstanceColorAppearance,
    ColorGeometryInstanceAttribute,
  } = Cesium;

  const renderChains = stitchAdjacentChains(chains, ellipsoid);
  const instances = [];
  for (const chain of renderChains) {
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

/** 合并条带：每段独立褪色（用于跳转后 consolidate） */
export function chainsToStripInstancesFromSegments(
  segments,
  halfWidthM,
  ellipsoid,
  fadeConfig,
  currentTime,
) {
  const {
    GeometryInstance,
    PolygonGeometry,
    PerInstanceColorAppearance,
    ColorGeometryInstanceAttribute,
    JulianDate,
  } = Cesium;

  const instances = [];
  for (const seg of segments) {
    const ageSec = JulianDate.secondsDifference(
      currentTime,
      seg.acquisitionTime,
    );
    const color = swathColorForAge(secondsToDays(ageSec), fadeConfig);
    const renderChains = stitchAdjacentChains(seg.chains, ellipsoid);
    for (const chain of renderChains) {
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
  }
  return instances;
}
