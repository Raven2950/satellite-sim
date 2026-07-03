import * as Cesium from 'cesium';
import {
  applyGlobalView,
  applyCameraSnapshot,
  computeAllViewModes,
  MIN_GLOBAL_DISTANCE_M,
  MAX_GLOBAL_DISTANCE_M,
} from '../orbit/camera.js';

const { CameraEventType, Cartesian3 } = Cesium;

/**
 * 全球视角相机：仅允许缩放，以地心为基准锁定朝向
 */
export class CameraController {
  constructor(viewer) {
    this.viewer = viewer;
    this.modes = computeAllViewModes();
    this.snapshot = null;
    this.minZoomDistance = MIN_GLOBAL_DISTANCE_M;
    this.maxZoomDistance = MAX_GLOBAL_DISTANCE_M;
    this._lockListener = null;
  }

  init() {
    this.snapshot = applyGlobalView(this.viewer, this.modes.global);
    this._installControls();
    this._enforceCameraLock();
  }

  recompute() {
    this.snapshot = applyGlobalView(this.viewer, this.modes.global);
    this._enforceCameraLock();
  }

  _installControls() {
    const c = this.viewer.scene.screenSpaceCameraController;

    c.enableTranslate = false;
    c.enableRotate = false;
    c.enableTilt = false;
    c.enableLook = false;
    c.enableZoom = true;

    c.zoomEventTypes = [CameraEventType.WHEEL, CameraEventType.PINCH];
    c.rotateEventTypes = [];
    c.tiltEventTypes = [];
    c.translateEventTypes = [];
    c.lookEventTypes = [];

    c.minimumZoomDistance = 1;
    c.maximumZoomDistance = Number.MAX_VALUE;

    if (this._lockListener) {
      this._lockListener();
    }

    this._lockListener = this.viewer.scene.preUpdate.addEventListener(() => {
      this._enforceCameraLock();
    });
  }

  /** 沿固定视线方向缩放，地心为基准点 */
  _enforceCameraLock() {
    const snap = this.snapshot;
    if (!snap?.pivot) return;

    const cam = this.viewer.camera;
    const inward = Cartesian3.negate(snap.direction, new Cartesian3());

    let dist = Cartesian3.dot(
      Cartesian3.subtract(cam.position, snap.pivot, new Cartesian3()),
      inward,
    );

    if (!Number.isFinite(dist) || dist <= 0) {
      dist = Cartesian3.distance(cam.position, snap.pivot);
    }

    dist = Math.max(this.minZoomDistance, Math.min(this.maxZoomDistance, dist));

    cam.direction = Cartesian3.clone(snap.direction);
    cam.up = Cartesian3.clone(snap.up);
    cam.position = Cartesian3.subtract(
      snap.pivot,
      Cartesian3.multiplyByScalar(snap.direction, dist, new Cartesian3()),
      new Cartesian3(),
    );
  }

  destroy() {
    if (this._lockListener) {
      this._lockListener();
      this._lockListener = null;
    }
  }
}
