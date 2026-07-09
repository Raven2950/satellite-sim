import * as Cesium from 'cesium';
import { CHINA_BOUNDS } from '../config/satellite.js';

const {
  Ion,
  Viewer,
  EllipsoidTerrainProvider,
  OpenStreetMapImageryProvider,
  TileMapServiceImageryProvider,
  createWorldImageryAsync,
  Color,
} = Cesium;

const NATURAL_EARTH_URL = `${import.meta.env.BASE_URL}cesium/Assets/Textures/NaturalEarthII`;

export function setGlobeStatus(message, ok = true) {
  const el = document.getElementById('globeStatus');
  if (el) {
    el.textContent = message;
    el.style.color = ok ? '#7ee8ff' : '#ff6b6b';
  }
}

export async function setupImagery(viewer) {
  viewer.imageryLayers.removeAll();

  const tryAdd = async (label, create) => {
    try {
      const provider = await create();
      if (provider.readyPromise) {
        await Promise.race([
          provider.readyPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timeout`)), 15000),
          ),
        ]);
      }
      viewer.imageryLayers.addImageryProvider(provider);
      setGlobeStatus(`地球影像已加载：${label}`);
      return true;
    } catch (err) {
      console.warn(`imagery ${label} failed:`, err);
      return false;
    }
  };

  if (
    await tryAdd('Natural Earth', () =>
      TileMapServiceImageryProvider.fromUrl(NATURAL_EARTH_URL),
    )
  ) {
    return;
  }

  if (
    Ion.defaultAccessToken &&
    (await tryAdd('Cesium Ion', () => createWorldImageryAsync()))
  ) {
    return;
  }

  if (
    await tryAdd('OpenStreetMap', () =>
      new OpenStreetMapImageryProvider({
        url: 'https://tile.openstreetmap.org/',
      }),
    )
  ) {
    return;
  }

  viewer.scene.globe.baseColor = Color.fromCssColorString('#2a6a9a');
  setGlobeStatus('影像加载失败，显示蓝色地球', false);
}

export function createViewer(containerId) {
  const token = import.meta.env.VITE_CESIUM_ION_TOKEN;
  if (token && token !== 'your_cesium_ion_token_here') {
    Ion.defaultAccessToken = token;
  }

  const viewer = new Viewer(containerId, {
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    terrainProvider: new EllipsoidTerrainProvider(),
    baseLayer: false,
  });

  if (viewer.cesiumWidget.creditContainer) {
    viewer.cesiumWidget.creditContainer.style.display = 'none';
  }

  viewer.scene.globe.show = true;
  viewer.scene.globe.enableLighting = true;
  viewer.scene.globe.dynamicAtmosphereLighting = true;
  viewer.scene.globe.dynamicAtmosphereLightingFromSun = true;
  viewer.scene.globe.showGroundAtmosphere = true;
  viewer.scene.globe.baseColor = Color.fromCssColorString('#2a6a9a');
  viewer.scene.globe.depthTestAgainstTerrain = false;
  viewer.scene.fog.enabled = false;
  viewer.scene.backgroundColor = Color.fromCssColorString('#0a1020');
  viewer.scene.moon.show = false;

  return viewer;
}

export function ensureViewerSize(viewer) {
  viewer.resize();
  viewer.scene.requestRender();
}
