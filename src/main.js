import 'cesium/Build/Cesium/Widgets/widgets.css';
import * as Cesium from 'cesium';
import {
  createViewer,
  setupImagery,
  ensureViewerSize,
} from './core/viewer.js';
import { CameraController } from './core/cameraController.js';
import { SimClock, getOrbitEpoch } from './core/simClock.js';
import { TIME_CONTROL, SIMULATION } from './config/satellite.js';
import { DEFAULT_SATELLITES } from './config/satellite.js';
import { SatelliteRegistry } from './satellites/registry.js';
import { orbitalPeriodSeconds, ensureIcrfReady } from './orbit/propagate.js';
import { TimeControls } from './ui/timeControls.js';
import './style.css';

const { JulianDate } = Cesium;

function renderParamDisplay(registry, simClock) {
  const sat = DEFAULT_SATELLITES[0];
  const periodMin = (orbitalPeriodSeconds(sat.orbit.altitudeKm) / 60).toFixed(1);
  const stats = registry?.getCoverageStats() ?? { cells: 0, rollDeg: 0 };
  const simDays = simClock?.getElapsedSimDays?.()?.toFixed(1) ?? '0.0';
  const rows = [
    ['轨道类型', '晨昏轨道（太阳同步）'],
    ['轨道高度', `${sat.orbit.altitudeKm} km`],
    ['传感器视场', `${sat.sensor.swathWidthKm} km`],
    ['偏转策略', '缺口补扫（0–30°）'],
    ['当前偏转角', `${stats.rollDeg.toFixed(1)}°`],
    ['轨道周期', `约 ${periodMin} 分钟/圈`],
    ['仿真天数', `${simDays} 天`],
    ['覆盖栅格', `${stats.cells.toLocaleString()} 格`],
  ];

  document.getElementById('paramDisplay').innerHTML = rows
    .map(
      ([label, value]) =>
        `<div class="param-row"><dt>${label}</dt><dd>${value}</dd></div>`,
    )
    .join('');
}

/**
 * 仿真主循环：setInterval 驱动，后台标签页仍可推进（浏览器会节流但不停）
 */
function startSimulationLoop(viewer, simClock, registry, timeControls) {
  let lastWall = Date.now();
  let lastUiRefresh = 0;
  let lastBgRender = 0;

  const step = () => {
    const now = Date.now();
    let wallDelta = (now - lastWall) / 1000;
    lastWall = now;

    const hidden = document.hidden;
    const maxDelta = hidden ? 30 : 0.25;
    wallDelta = Math.min(Math.max(wallDelta, 0), maxDelta);

    simClock.tick(wallDelta);
    simClock.syncToViewer(viewer);
    registry.updateAll(simClock.currentTime);

    if (now - lastUiRefresh > 1000) {
      timeControls.refresh();
      renderParamDisplay(registry, simClock);
      lastUiRefresh = now;
    }

    const shouldRender = !hidden || now - lastBgRender > 3000;
    if (shouldRender) {
      viewer.scene.requestRender();
      lastBgRender = now;
    }
  };

  setInterval(step, 50);

  document.addEventListener('visibilitychange', () => {
    lastWall = Date.now();
  });

  if (!document.hidden) {
    const renderLoop = () => {
      if (!document.hidden) {
        viewer.scene.requestRender();
      }
      requestAnimationFrame(renderLoop);
    };
    requestAnimationFrame(renderLoop);
  }
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
    simClock.markSimAnchor();

    if (loadingEl) loadingEl.textContent = '正在加载轨道数据…';
    try {
      const now = simClock.currentTime;
      const icrfStart = JulianDate.addDays(
        now,
        -30,
        new JulianDate(),
      );
      const icrfStop = JulianDate.addDays(
        now,
        SIMULATION.icrfPreloadDays ?? 400,
        new JulianDate(),
      );
      await ensureIcrfReady(icrfStart, icrfStop);
    } catch (err) {
      console.warn('ICRF preload failed, using Earth-rotation fallback:', err);
    }

    const orbitEpoch = getOrbitEpoch();
    const registry = new SatelliteRegistry(viewer, orbitEpoch);

    const onTimeChange = () => {
      simClock.syncToViewer(viewer);
      registry.updateAll(simClock.currentTime);
      renderParamDisplay(registry, simClock);
      viewer.scene.requestRender();
    };

    registry.registerAll(DEFAULT_SATELLITES);
    await registry.loadAllModels();
    onTimeChange();

    const timeControls = new TimeControls(simClock, { onChange: onTimeChange });
    startSimulationLoop(viewer, simClock, registry, timeControls);

    renderParamDisplay(registry, simClock);
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
