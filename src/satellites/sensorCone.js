import * as Cesium from 'cesium';
import { buildSwathQuad } from '../swath/geometry.js';

const {
  Cartesian3,
  Color,
  Matrix4,
  Transforms,
  Math: CesiumMath,
  HeadingPitchRoll,
  PolylineGlowMaterialProperty,
} = Cesium;

/** ESA 风格亮绿色 */
const CONE_EDGE = Color.fromBytes(120, 255, 180, 255);

export function computeNadirFootprintCorners(
  groundCenter,
  velocityEcef,
  halfWidthM,
  alongHalfM,
  ellipsoid,
) {
  const up = ellipsoid.geodeticSurfaceNormal(groundCenter, new Cartesian3());
  const velUp = Cartesian3.dot(velocityEcef, up);
  let along = Cartesian3.subtract(
    velocityEcef,
    Cartesian3.multiplyByScalar(up, velUp, new Cartesian3()),
    new Cartesian3(),
  );

  if (Cartesian3.magnitudeSquared(along) < 1) {
    const enu = Transforms.eastNorthUpToFixedFrame(groundCenter, ellipsoid);
    along = Matrix4.getColumn(enu, 0, new Cartesian3());
  } else {
    Cartesian3.normalize(along, along);
  }

  const back = Cartesian3.add(
    groundCenter,
    Cartesian3.multiplyByScalar(along, -alongHalfM, new Cartesian3()),
    new Cartesian3(),
  );
  const front = Cartesian3.add(
    groundCenter,
    Cartesian3.multiplyByScalar(along, alongHalfM, new Cartesian3()),
    new Cartesian3(),
  );

  return buildSwathQuad(back, front, halfWidthM, ellipsoid);
}

/**
 * 瞬时传感器视场：纯 Entity 更新（无 Primitive 重建，避免残留鬼影）
 * 始终对地星下点视场，与偏转补扫条带无关
 */
export class SensorCone {
  constructor(viewer, idPrefix, options = {}) {
    this.viewer = viewer;
    this.ellipsoid = viewer.scene.globe.ellipsoid;
    this.idPrefix = idPrefix;
    this.halfWidthM = options.halfWidthM ?? 30_000;
    this.alongHalfM = options.alongHalfM ?? this.halfWidthM;

    const glowMat = new PolylineGlowMaterialProperty({
      glowPower: 0.4,
      taperPower: 0.3,
      color: CONE_EDGE,
    });

    this._edgeEntities = [0, 1, 2, 3].map((i) =>
      viewer.entities.add({
        id: `${idPrefix}-sensor-edge-${i}`,
        polyline: {
          width: 8,
          material: glowMat,
          arcType: Cesium.ArcType.NONE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }),
    );

    this._groundRingEntity = viewer.entities.add({
      id: `${idPrefix}-sensor-ground-ring`,
      polyline: {
        width: 6,
        material: glowMat,
        arcType: Cesium.ArcType.NONE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });

    this._groundFillEntity = viewer.entities.add({
      id: `${idPrefix}-sensor-ground-fill`,
      polygon: {
        material: Color.fromBytes(80, 255, 140, 120),
        perPositionHeight: true,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  update(satPos, nadirGround, velocityEcef) {
    const corners = computeNadirFootprintCorners(
      nadirGround,
      velocityEcef,
      this.halfWidthM,
      this.alongHalfM,
      this.ellipsoid,
    );
    if (!corners) return;

    const [c0, c1, c2, c3] = corners;

    this._edgeEntities[0].polyline.positions = [satPos, c0];
    this._edgeEntities[1].polyline.positions = [satPos, c1];
    this._edgeEntities[2].polyline.positions = [satPos, c2];
    this._edgeEntities[3].polyline.positions = [satPos, c3];
    this._groundRingEntity.polyline.positions = [c0, c1, c2, c3, c0];
    this._groundFillEntity.polygon.hierarchy = [c0, c1, c2, c3];
  }

  destroy() {
    for (const id of [
      `${this.idPrefix}-sensor-ground-fill`,
      `${this.idPrefix}-sensor-ground-ring`,
      ...[0, 1, 2, 3].map((i) => `${this.idPrefix}-sensor-edge-${i}`),
    ]) {
      const e = this.viewer.entities.getById(id);
      if (e) this.viewer.entities.remove(e);
    }
    this._edgeEntities = [];
    this._groundRingEntity = null;
    this._groundFillEntity = null;
  }
}

export function computeNadirOrientation(pos, velocityEcef, ellipsoid, offsetDeg = {}) {
  const up = ellipsoid.geodeticSurfaceNormal(pos, new Cartesian3());
  const east = Cartesian3.normalize(
    Cartesian3.cross(Cartesian3.UNIT_Z, up, new Cartesian3()),
    new Cartesian3(),
  );
  const north = Cartesian3.normalize(
    Cartesian3.cross(up, east, new Cartesian3()),
    new Cartesian3(),
  );

  let heading = 0;
  const vE = Cartesian3.dot(velocityEcef, east);
  const vN = Cartesian3.dot(velocityEcef, north);
  if (vE * vE + vN * vN > 1) {
    heading = Math.atan2(vE, vN);
  }

  return Transforms.headingPitchRollQuaternion(
    pos,
    new HeadingPitchRoll(
      heading + CesiumMath.toRadians(offsetDeg.yaw ?? 0),
      CesiumMath.toRadians(-90 + (offsetDeg.pitch ?? 0)),
      CesiumMath.toRadians(offsetDeg.roll ?? 0),
    ),
    ellipsoid,
  );
}
