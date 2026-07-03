import 'cesium/Build/Cesium/Widgets/widgets.css';
import {
  createViewer,
  setupImagery,
  ensureViewerSize,
} from './core/viewer.js';
import { CameraController } from './core/cameraController.js';
import { SimClock, getOrbitEpoch } from './core/simClock.js';
import { TIME_CONTROL } from './config/satellite.js';
import { DEFAULT_SATELLITES } from './config/satellite.js';
import { SatelliteRegistry } from './satellites/registry.js';
import { orbitalPeriodSeconds } from './orbit/propagate.js';
import { TimeControls } from './ui/timeControls.js';
import './style.css';

function renderParamDisplay() {
  const sat = DEFAULT_SATELLITES[0];
  const periodMin = (orbitalPeriodSeconds(sat.orbit.altitudeKm) / 60).toFixed(1);
  const rows = [
    ['轨道类型', '晨昏轨道（太阳同步）'],
    ['轨道高度', `${sat.orbit.altitudeKm} km`],
    ['拍摄幅宽', `${sat.sensor.swathWidthKm} km`],
    ['轨道周期', `约 ${periodMin} 分钟/圈`],
  ];

  document.getElementById('paramDisplay').innerHTML = rows
    .map(
      ([label, value]) =>
        `<div class="param-row"><dt>${label}</dt><dd>${value}</dd></div>`,
    )
    .join('');
}

function startAnimationLoop(viewer, simClock, registry, timeControls) {
  let lastWall = performance.now();
  let lastUiRefresh = 0;

  const frame = () => {
    const now = performance.now();
    const wallDelta = Math.min((now - lastWall) / 1000, 0.1);
    lastWall = now;

    simClock.tick(wallDelta);
    simClock.syncToViewer(viewer);
    registry.updateAll(simClock.currentTime);

    if (now - lastUiRefresh > 1000) {
      timeControls.refresh();
      lastUiRefresh = now;
    }

    viewer.scene.requestRender();
    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}

async function main() {
  const loadingEl = document.getElementById('loadingOverlay');

  try {
    const viewer = createViewer('cesiumContainer');

    await new Promise((r) => requestAnimationFrame(r));
    ensureViewerSize(viewer);
    setTimeout(() => ensureViewerSize(viewer), 100);
    setTimeout(() => ensureViewerSize(viewer), 500);

    await setupImagery(viewer);
    ensureViewerSize(viewer);

    const cameraController = new CameraController(viewer);
    cameraController.init();

    ensureViewerSize(viewer);

    if (loadingEl) loadingEl.classList.add('hidden');

    window.addEventListener('resize', () => {
      ensureViewerSize(viewer);
      cameraController.recompute();
    });

    const simClock = new SimClock(TIME_CONTROL.speed1, TIME_CONTROL.speed2);
    const orbitEpoch = getOrbitEpoch();
    const registry = new SatelliteRegistry(viewer, orbitEpoch);

    const onTimeChange = () => {
      simClock.syncToViewer(viewer);
      registry.updateAll(simClock.currentTime);
      viewer.scene.requestRender();
    };

    registry.registerAll(DEFAULT_SATELLITES);
    registry.loadAllModels().catch((err) => {
      console.warn('Satellite model load:', err);
    });
    onTimeChange();

    const timeControls = new TimeControls(simClock, { onChange: onTimeChange });
    startAnimationLoop(viewer, simClock, registry, timeControls);

    renderParamDisplay();
  } catch (err) {
    console.error(err);
    if (loadingEl) loadingEl.classList.add('hidden');
    showError(err?.message ?? String(err));
  }
}

function showError(message) {
  const banner = document.createElement('div');
  banner.className = 'error-banner';
  banner.textContent = message;
  document.body.appendChild(banner);
}

main();
