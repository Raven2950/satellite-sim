import * as Cesium from 'cesium';
import { buildSwathQuad } from '../swath/geometry.js';

const {
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  GeometryInstance,
  Matrix4,
  PerInstanceColorAppearance,
  PolygonHierarchy,
  Primitive,
  Transforms,
  Math: CesiumMath,
  HeadingPitchRoll,
  PolylineGlowMaterialProperty,
} = Cesium;

/** ESA 风格亮绿色 */
const CONE_FILL = Color.fromBytes(50, 255, 120, 200);
const CONE_EDGE = Color.fromBytes(120, 255, 180, 255);
const CONE_GROUND = Color.fromBytes(80, 255, 140, 230);

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

function _writeTri(a, b, c, arr, offset) {
  arr[offset] = a.x;
  arr[offset + 1] = a.y;
  arr[offset + 2] = a.z;
  arr[offset + 3] = b.x;
  arr[offset + 4] = b.y;
  arr[offset + 5] = b.z;
  arr[offset + 6] = c.x;
  arr[offset + 7] = c.y;
  arr[offset + 8] = c.z;
}

/**
 * ESA 风格传感器锥：实心半透明四棱锥 + 发光棱线 + 地面高亮
 */
export class SensorCone {
  constructor(viewer, idPrefix, options = {}) {
    this.viewer = viewer;
    this.ellipsoid = viewer.scene.globe.ellipsoid;
    this.idPrefix = idPrefix;

    this.fillColor = options.fillColor ?? CONE_FILL;
    this.halfWidthM = options.halfWidthM ?? 30_000;
    this.alongHalfM = options.alongHalfM ?? this.halfWidthM;

    this._bodyPrimitive = null;
    this._groundPrimitive = null;

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
  }

  update(satPos, groundCenter, velocityEcef) {
    const corners = computeNadirFootprintCorners(
      groundCenter,
      velocityEcef,
      this.halfWidthM,
      this.alongHalfM,
      this.ellipsoid,
    );
    if (!corners) return;

    const [c0, c1, c2, c3] = corners;

    this._rebuildBodyPrimitive(satPos, c0, c1, c2, c3);
    this._rebuildGroundPrimitive(c0, c1, c2, c3);

    this._edgeEntities[0].polyline.positions = [satPos, c0];
    this._edgeEntities[1].polyline.positions = [satPos, c1];
    this._edgeEntities[2].polyline.positions = [satPos, c2];
    this._edgeEntities[3].polyline.positions = [satPos, c3];
    this._groundRingEntity.polyline.positions = [c0, c1, c2, c3, c0];
  }

  _removePrimitive(ref) {
    const primitive = this[ref];
    if (!primitive) return;
    this.viewer.scene.primitives.remove(primitive);
    if (!primitive.isDestroyed()) {
      primitive.destroy();
    }
    this[ref] = null;
  }

  _makePrimitive(positions, indices, color) {
    return new Primitive({
      geometryInstances: new GeometryInstance({
        geometry: new Cesium.Geometry({
          attributes: {
            position: new Cesium.GeometryAttribute({
              componentDatatype: Cesium.ComponentDatatype.DOUBLE,
              componentsPerAttribute: 3,
              values: positions,
            }),
          },
          indices,
          primitiveType: Cesium.PrimitiveType.TRIANGLES,
          boundingSphere: Cesium.BoundingSphere.fromVertices(positions),
        }),
        attributes: {
          color: ColorGeometryInstanceAttribute.fromColor(color),
        },
      }),
      appearance: new PerInstanceColorAppearance({
        flat: true,
        translucent: true,
        closed: false,
        renderState: {
          depthTest: { enabled: false },
          depthMask: false,
          blending: Cesium.BlendingState.ALPHA_BLEND,
          cull: { enabled: false },
        },
      }),
      asynchronous: false,
    });
  }

  _rebuildBodyPrimitive(sat, c0, c1, c2, c3) {
    const positions = new Float64Array(5 * 3 * 3);
    _writeTri(sat, c0, c1, positions, 0);
    _writeTri(sat, c1, c2, positions, 9);
    _writeTri(sat, c2, c3, positions, 18);
    _writeTri(sat, c3, c0, positions, 27);

    this._removePrimitive('_bodyPrimitive');
    this._bodyPrimitive = this._makePrimitive(
      positions,
      new Uint16Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
      this.fillColor,
    );
    this.viewer.scene.primitives.add(this._bodyPrimitive);
  }

  _rebuildGroundPrimitive(c0, c1, c2, c3) {
    const positions = new Float64Array(2 * 3 * 3);
    _writeTri(c0, c1, c2, positions, 0);
    _writeTri(c0, c2, c3, positions, 9);

    this._removePrimitive('_groundPrimitive');
    this._groundPrimitive = this._makePrimitive(
      positions,
      new Uint16Array([0, 1, 2, 3, 4, 5]),
      CONE_GROUND,
    );
    this.viewer.scene.primitives.add(this._groundPrimitive);
  }

  destroy() {
    this._removePrimitive('_bodyPrimitive');
    this._removePrimitive('_groundPrimitive');
    for (const id of [
      `${this.idPrefix}-sensor-ground-ring`,
      ...[0, 1, 2, 3].map((i) => `${this.idPrefix}-sensor-edge-${i}`),
    ]) {
      const e = this.viewer.entities.getById(id);
      if (e) this.viewer.entities.remove(e);
    }
    this._edgeEntities = [];
    this._groundRingEntity = null;
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
