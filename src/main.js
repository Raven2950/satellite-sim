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

/** 后台每步最大仿真推进（秒） */
const BG_SIM_CHUNK_SEC = 90;

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

function startSimulationLoop(viewer, simClock, registry, timeControls) {
  let lastWall = performance.now();
  let lastBgWall = Date.now();
  let lastUiRefresh = 0;
  let bgTimer = null;

  const syncAndUpdate = () => {
    simClock.syncToViewer(viewer);
    registry.updateAll(simClock.currentTime);
  };

  /** 后台：把墙钟时间拆成多步仿真推进 */
  const advanceBackground = (wallDeltaSec) => {
    if (simClock.live || !simClock.playing || wallDeltaSec <= 0) return;

    let remaining = wallDeltaSec * simClock.multiplier;
    while (remaining > 0.5) {
      const chunk = Math.min(remaining, BG_SIM_CHUNK_SEC);
      JulianDate.addSeconds(
        simClock.currentTime,
        chunk,
        simClock.currentTime,
      );
      simClock.currentTime = simClock.clamp(simClock.currentTime);
      registry.updateAll(simClock.currentTime);
      remaining -= chunk;
    }
    simClock.syncToViewer(viewer);
  };

  const frame = () => {
    const now = performance.now();
    const wallDelta = Math.min((now - lastWall) / 1000, 0.1);
    lastWall = now;

    if (!document.hidden) {
      simClock.tick(wallDelta);
      syncAndUpdate();

      if (now - lastUiRefresh > 1000) {
        timeControls.refresh();
        renderParamDisplay(registry, simClock);
        lastUiRefresh = now;
      }
      viewer.scene.requestRender();
    }

    requestAnimationFrame(frame);
  };

  const startBgTimer = () => {
    if (bgTimer) return;
    lastBgWall = Date.now();
    bgTimer = setInterval(() => {
      const now = Date.now();
      const wallDelta = (now - lastBgWall) / 1000;
      lastBgWall = now;
      advanceBackground(wallDelta);
      viewer.scene.requestRender();
    }, 1000);
  };

  const stopBgTimer = () => {
    if (!bgTimer) return;
    clearInterval(bgTimer);
    bgTimer = null;
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      lastBgWall = Date.now();
      startBgTimer();
    } else {
      const catchup = (Date.now() - lastBgWall) / 1000;
      stopBgTimer();
      advanceBackground(catchup);
      lastWall = performance.now();
      viewer.scene.requestRender();
    }
  });

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
    simClock.markSimAnchor();

    if (loadingEl) loadingEl.textContent = '正在加载轨道数据…';
    try {
      const now = simClock.currentTime;
      const icrfStart = JulianDate.addDays(now, -30, new JulianDate());
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
