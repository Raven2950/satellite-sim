/**
 * vite-plugin-cesium copies assets to dist/satellite-sim/cesium/ when base is set,
 * but index.html references /satellite-sim/cesium/ (→ dist/cesium/ on GitHub Pages).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '..', 'dist');
const nested = path.join(dist, 'satellite-sim', 'cesium');
const target = path.join(dist, 'cesium');

if (fs.existsSync(nested)) {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  fs.renameSync(nested, target);
  const wrapper = path.join(dist, 'satellite-sim');
  if (fs.existsSync(wrapper)) {
    fs.rmSync(wrapper, { recursive: true, force: true });
  }
  console.log('Fixed Cesium output path → dist/cesium/');
} else if (fs.existsSync(target)) {
  console.log('Cesium already at dist/cesium/');
} else {
  console.warn('No Cesium folder found in dist/');
}
