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

  get coveredCellCount() {
    return this.covered.size;
  }

  mergeFrom(other) {
    for (const key of other.covered) {
      this.covered.add(key);
    }
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

/**
 * 默认对地；星下点进入历史已扫区域时锁定偏转角至本圈结束（仅影响白痕）
 * 本圈内的实时标记单独累积，避免把刚扫过的条带误判为“重访”而提前偏转
 */
export class CoveragePlanner {
  constructor(orbitConfig, sensorConfig) {
    this.orbitConfig = orbitConfig;
    this.sensorConfig = sensorConfig;
    this.grid = new CoverageGrid(sensorConfig.coverageCellDeg ?? 0.05);
    this.sessionGrid = new CoverageGrid(sensorConfig.coverageCellDeg ?? 0.05);
    this.halfSwathM = (sensorConfig.swathWidthKm * 1000) / 2;
    this.altitudeM = orbitConfig.altitudeKm * 1000;
    this.maxRollDeg = sensorConfig.maxRollDeg ?? 30;
    this.maxCrossM =
      this.altitudeM * Math.tan(CesiumMath.toRadians(this.maxRollDeg));
    this._prevSwath = null;
    this._passRollDeg = 0;
    this._passRollLocked = false;
    this.currentRollDeg = 0;
  }

  get coveredCellCount() {
    return this.grid.coveredCellCount + this.sessionGrid.coveredCellCount;
  }

  reset() {
    this.grid.clear();
    this.sessionGrid.clear();
    this._prevSwath = null;
    this._passRollDeg = 0;
    this._passRollLocked = false;
    this.currentRollDeg = 0;
  }

  /** 每圈开始时：上一圈标记并入历史，并重置段内偏转状态 */
  beginPass() {
    this.grid.mergeFrom(this.sessionGrid);
    this.sessionGrid.clear();
    this._passRollDeg = 0;
    this._passRollLocked = false;
    this.currentRollDeg = 0;
    this._prevSwath = null;
  }

  _isCoveredAny(latDeg, lonDeg) {
    return (
      this.grid.isCovered(latDeg, lonDeg) ||
      this.sessionGrid.isCovered(latDeg, lonDeg)
    );
  }

  _markSession(swathGround, ellipsoid) {
    if (this._prevSwath) {
      this.sessionGrid.markSegment(
        this._prevSwath,
        swathGround,
        this.halfSwathM,
        ellipsoid,
      );
    } else {
      this.sessionGrid.markFootprint(swathGround, this.halfSwathM, ellipsoid);
    }
    this._prevSwath = Cartesian3.clone(
      swathGround,
      this._prevSwath ?? new Cartesian3(),
    );
  }

  /**
   * @returns {{ nadirGround, swathGround, rollDeg: number, isRolled: boolean }}
   */
  planImaging(
    julianDate,
    secondsSinceEpoch,
    nadirGround,
    vel,
    ellipsoid,
    { markGrid = true } = {},
  ) {
    const nadirCovered = this.grid.isCoveredAtCartesian(nadirGround, ellipsoid);

    if (!this._passRollLocked && nadirCovered) {
      const rollDeg = this._pickRollAngle(nadirGround, vel, ellipsoid);
      if (rollDeg !== null) {
        this._passRollDeg = rollDeg;
        this._passRollLocked = true;
      }
    }

    this.currentRollDeg = this._passRollLocked ? this._passRollDeg : 0;

    let swathGround = nadirGround;
    if (this._passRollLocked && Math.abs(this._passRollDeg) > 0.01) {
      swathGround = computeGroundCartesian(
        julianDate,
        secondsSinceEpoch,
        this.orbitConfig,
        { ...this.sensorConfig, rollDeg: this._passRollDeg },
        ellipsoid,
      );
    }

    if (markGrid) {
      this._markSession(swathGround, ellipsoid);
    }

    return {
      nadirGround,
      swathGround,
      rollDeg: this.currentRollDeg,
      isRolled: this._passRollLocked && Math.abs(this._passRollDeg) > 0.01,
    };
  }

  /** 触发时一次性选择侧向偏转，指向邻近未覆盖区 */
  _pickRollAngle(nadirGround, vel, ellipsoid) {
    if (this.maxRollDeg < 0.5) return null;

    const up = ellipsoid.geodeticSurfaceNormal(nadirGround, _scratchUp);
    let along = Cartesian3.cross(up, vel, _scratchAlong);
    if (Cartesian3.magnitudeSquared(along) < 1e-6) {
      along = Cartesian3.cross(up, Cartesian3.UNIT_X, _scratchAlong);
    }
    Cartesian3.normalize(along, along);

    const cross = Cartesian3.cross(up, along, _scratchCross);
    Cartesian3.normalize(cross, cross);

    const crossSteps = 8;
    const minCross = this.halfSwathM * 0.5;
    const maxCross = Math.min(this.maxCrossM, this.halfSwathM * 2);

    for (let ci = 1; ci <= crossSteps; ci++) {
      const crossDist = minCross + ((maxCross - minCross) * ci) / crossSteps;
      for (const side of [-1, 1]) {
        const offset = Cartesian3.multiplyByScalar(
          cross,
          side * crossDist,
          _scratchOffset,
        );
        const raw = Cartesian3.add(nadirGround, offset, _scratchTarget);
        const c = ellipsoid.cartesianToCartographic(raw);
        const lat = CesiumMath.toDegrees(c.latitude);
        const lon = CesiumMath.toDegrees(c.longitude);

        if (this._isCoveredAny(lat, lon)) continue;

        const rollDeg =
          side * CesiumMath.toDegrees(Math.atan2(crossDist, this.altitudeM));
        if (Math.abs(rollDeg) > this.maxRollDeg + 0.01) continue;

        return rollDeg;
      }
    }

    return null;
  }
}
