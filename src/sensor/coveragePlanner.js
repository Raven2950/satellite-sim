import * as Cesium from 'cesium';
import { computeGroundCartesian } from '../orbit/propagate.js';

const { Cartesian3, Math: CesiumMath } = Cesium;

const M_PER_DEG_LAT = 111320;

/** 全球覆盖栅格（标记已被 60 km 视场扫过的区域） */
export class CoverageGrid {
  constructor(cellDeg = 0.05) {
    this.cellDeg = cellDeg;
    this.covered = new Set();
  }

  _key(latDeg, lonDeg) {
    const i = Math.floor(latDeg / this.cellDeg);
    const j = Math.floor(lonDeg / this.cellDeg);
    return `${i},${j}`;
  }

  isCovered(latDeg, lonDeg) {
    return this.covered.has(this._key(latDeg, lonDeg));
  }

  isCoveredAtCartesian(cartesian, ellipsoid) {
    const c = ellipsoid.cartesianToCartographic(cartesian);
    return this.isCovered(
      CesiumMath.toDegrees(c.latitude),
      CesiumMath.toDegrees(c.longitude),
    );
  }

  mark(latDeg, lonDeg) {
    this.covered.add(this._key(latDeg, lonDeg));
  }

  /** 传感器视场圆（半幅宽 = swathWidth/2） */
  markFootprint(center, halfWidthM, ellipsoid) {
    const carto = ellipsoid.cartesianToCartographic(center);
    const lat = CesiumMath.toDegrees(carto.latitude);
    const lon = CesiumMath.toDegrees(carto.longitude);
    const latR = halfWidthM / M_PER_DEG_LAT;
    const cosLat = Math.max(0.15, Math.cos(carto.latitude));
    const lonR = halfWidthM / (M_PER_DEG_LAT * cosLat);
    for (let la = lat - latR; la <= lat + latR; la += this.cellDeg) {
      for (let lo = lon - lonR; lo <= lon + lonR; lo += this.cellDeg) {
        this.mark(la, lo);
      }
    }
  }

  markSegment(p0, p1, halfWidthM, ellipsoid) {
    const dist = Cartesian3.distance(p0, p1);
    const step = Math.max(halfWidthM * 0.3, 8000);
    const n = Math.max(1, Math.ceil(dist / step));
    for (let i = 0; i <= n; i++) {
      const p = Cartesian3.lerp(p0, p1, i / n, new Cartesian3());
      const carto = ellipsoid.cartesianToCartographic(p);
      carto.height = 0;
      const onSurf = ellipsoid.cartographicToCartesian(carto);
      this.markFootprint(onSurf, halfWidthM, ellipsoid);
    }
  }

  /** 该点邻域内是否存在已覆盖栅格（条带边缘缺口判定） */
  hasCoveredNeighbor(latDeg, lonDeg, radiusDeg) {
    const steps = Math.max(1, Math.ceil(radiusDeg / this.cellDeg));
    for (let di = -steps; di <= steps; di++) {
      for (let dj = -steps; dj <= steps; dj++) {
        if (di === 0 && dj === 0) continue;
        if (this.isCovered(latDeg + di * this.cellDeg, lonDeg + dj * this.cellDeg)) {
          return true;
        }
      }
    }
    return false;
  }

  get coveredCellCount() {
    return this.covered.size;
  }

  clear() {
    this.covered.clear();
  }
}

const _scratchAlong = new Cartesian3();
const _scratchCross = new Cartesian3();
const _scratchUp = new Cartesian3();
const _scratchOffset = new Cartesian3();
const _scratchTarget = new Cartesian3();
const _scratchSurf = new Cartesian3();

/**
 * 策略 A：默认对地；仅在当前轨迹后方、紧贴已扫条带边缘的未覆盖缺口处偏转补扫
 */
export class CoveragePlanner {
  constructor(orbitConfig, sensorConfig) {
    this.orbitConfig = orbitConfig;
    this.sensorConfig = sensorConfig;
    this.grid = new CoverageGrid(sensorConfig.coverageCellDeg ?? 0.05);
    this.halfSwathM = (sensorConfig.swathWidthKm * 1000) / 2;
    this.altitudeM = orbitConfig.altitudeKm * 1000;
    this.maxRollDeg = sensorConfig.maxRollDeg ?? 30;
    this.maxCrossM =
      this.altitudeM * Math.tan(CesiumMath.toRadians(this.maxRollDeg));
    /** 仅在条带外缘再向外搜索的窄带（米） */
    this.gapBandM = sensorConfig.gapSearchBandM ?? 20_000;
    /** 沿轨向后搜索长度（米） */
    this.behindAlongM = sensorConfig.gapSearchBehindM ?? 80_000;
    this._prevNadir = null;
    this.currentRollDeg = 0;
    this.lastGapFill = false;
  }

  reset() {
    this.grid.clear();
    this._prevNadir = null;
    this.currentRollDeg = 0;
    this.lastGapFill = false;
  }

  /**
   * @returns {{ nadirGround, rollGround: Cartesian3|null, rollDeg: number }}
   */
  planImaging(julianDate, secondsSinceEpoch, nadirGround, vel, ellipsoid) {
    if (this._prevNadir) {
      this.grid.markSegment(
        this._prevNadir,
        nadirGround,
        this.halfSwathM,
        ellipsoid,
      );
    } else {
      this.grid.markFootprint(nadirGround, this.halfSwathM, ellipsoid);
    }
    this._prevNadir = Cartesian3.clone(
      nadirGround,
      this._prevNadir ?? new Cartesian3(),
    );

    const rollPlan = this._findBestGapTarget(nadirGround, vel, ellipsoid);
    this.lastGapFill = Boolean(rollPlan);
    this.currentRollDeg = rollPlan?.rollDeg ?? 0;

    let rollGround = null;
    if (rollPlan) {
      rollGround = computeGroundCartesian(
        julianDate,
        secondsSinceEpoch,
        this.orbitConfig,
        { ...this.sensorConfig, rollDeg: rollPlan.rollDeg },
        ellipsoid,
      );
      this.grid.markFootprint(rollGround, this.halfSwathM, ellipsoid);
    }

    return {
      nadirGround,
      rollGround,
      rollDeg: this.currentRollDeg,
    };
  }

  /**
   * 仅用于条带几何稠密重采样：不写入覆盖栅格，避免 finalize 重复标记
   */
  sampleSwathPoints(julianDate, secondsSinceEpoch, nadirGround, vel, ellipsoid) {
    const rollPlan = this._findBestGapTarget(nadirGround, vel, ellipsoid);
    this.lastGapFill = Boolean(rollPlan);
    this.currentRollDeg = rollPlan?.rollDeg ?? 0;

    let rollGround = null;
    if (rollPlan) {
      rollGround = computeGroundCartesian(
        julianDate,
        secondsSinceEpoch,
        this.orbitConfig,
        { ...this.sensorConfig, rollDeg: rollPlan.rollDeg },
        ellipsoid,
      );
    }

    this._prevNadir = Cartesian3.clone(
      nadirGround,
      this._prevNadir ?? new Cartesian3(),
    );

    return {
      nadirGround,
      rollGround,
      rollDeg: this.currentRollDeg,
    };
  }

  /**
   * 星下点落在已扫区域时：侧向偏转，把视场移到邻近未覆盖区
   */
  _findOverlapAvoidanceRoll(nadirGround, vel, ellipsoid) {
    const up = ellipsoid.geodeticSurfaceNormal(nadirGround, _scratchUp);
    let along = Cartesian3.cross(up, vel, _scratchAlong);
    if (Cartesian3.magnitudeSquared(along) < 1e-6) {
      along = Cartesian3.cross(up, Cartesian3.UNIT_X, _scratchAlong);
    }
    Cartesian3.normalize(along, along);

    const cross = Cartesian3.cross(up, along, _scratchCross);
    Cartesian3.normalize(cross, cross);

    const crossSteps = 8;
    const minCross = this.halfSwathM * 0.25;
    const maxCross = Math.min(this.maxCrossM, this.halfSwathM * 2.5);

    for (let ci = 1; ci <= crossSteps; ci++) {
      const crossDist = minCross + ((maxCross - minCross) * ci) / crossSteps;
      for (const side of [-1, 1]) {
        const offset = Cartesian3.multiplyByScalar(
          cross,
          side * crossDist,
          _scratchOffset,
        );
        const raw = Cartesian3.add(nadirGround, offset, _scratchTarget);
        const carto = ellipsoid.cartesianToCartographic(raw);
        carto.height = 0;
        const lat = CesiumMath.toDegrees(carto.latitude);
        const lon = CesiumMath.toDegrees(carto.longitude);

        if (this.grid.isCovered(lat, lon)) continue;

        const rollDeg =
          side * CesiumMath.toDegrees(Math.atan2(crossDist, this.altitudeM));
        if (Math.abs(rollDeg) > this.maxRollDeg + 0.01) continue;

        return { rollDeg };
      }
    }

    return null;
  }

  /**
   * 仅在「当前轨迹后方 + 条带外缘窄带 + 邻接已覆盖区」的未覆盖点中择优
   */
  _findEdgeGapRoll(nadirGround, vel, ellipsoid) {
    const up = ellipsoid.geodeticSurfaceNormal(nadirGround, _scratchUp);
    let along = Cartesian3.cross(up, vel, _scratchAlong);
    if (Cartesian3.magnitudeSquared(along) < 1e-6) {
      along = Cartesian3.cross(up, Cartesian3.UNIT_X, _scratchAlong);
    }
    Cartesian3.normalize(along, along);

    const cross = Cartesian3.cross(up, along, _scratchCross);
    Cartesian3.normalize(cross, cross);

    const minCross = this.halfSwathM * 0.98;
    const maxCross = Math.min(
      this.halfSwathM + this.gapBandM,
      this.maxCrossM,
    );
    if (maxCross <= minCross) return null;

    const behindM = this.behindAlongM;
    const alongSteps = 10;
    const crossSteps = 6;
    const neighborRadiusDeg = (this.halfSwathM * 0.15) / M_PER_DEG_LAT;

    let best = null;
    let bestScore = -1;

    for (let ai = 1; ai <= alongSteps; ai++) {
      const alongDist = (-behindM * ai) / alongSteps;
      for (const side of [-1, 1]) {
        for (let ci = 1; ci <= crossSteps; ci++) {
          const crossDist =
            minCross + ((maxCross - minCross) * ci) / crossSteps;

          const offset = Cartesian3.add(
            Cartesian3.multiplyByScalar(along, alongDist, new Cartesian3()),
            Cartesian3.multiplyByScalar(
              cross,
              side * crossDist,
              new Cartesian3(),
            ),
            _scratchOffset,
          );
          const raw = Cartesian3.add(nadirGround, offset, _scratchTarget);
          const carto = ellipsoid.cartesianToCartographic(raw);
          carto.height = 0;

          const lat = CesiumMath.toDegrees(carto.latitude);
          const lon = CesiumMath.toDegrees(carto.longitude);

          if (this.grid.isCovered(lat, lon)) continue;
          if (!this.grid.hasCoveredNeighbor(lat, lon, neighborRadiusDeg)) {
            continue;
          }

          const rollDeg =
            side *
            CesiumMath.toDegrees(Math.atan2(crossDist, this.altitudeM));
          if (Math.abs(rollDeg) > this.maxRollDeg + 0.01) continue;

          const score = 1 / crossDist + ai * 0.001;
          if (score > bestScore) {
            bestScore = score;
            best = { rollDeg };
          }
        }
      }
    }

    return best;
  }

  _findBestGapTarget(nadirGround, vel, ellipsoid) {
    if (this.maxRollDeg < 0.5 || !this._prevNadir) return null;

    if (this.grid.isCoveredAtCartesian(nadirGround, ellipsoid)) {
      const overlapRoll = this._findOverlapAvoidanceRoll(
        nadirGround,
        vel,
        ellipsoid,
      );
      if (overlapRoll) return overlapRoll;
    }

    return this._findEdgeGapRoll(nadirGround, vel, ellipsoid);
  }
}
