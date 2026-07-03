import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';

export default defineConfig({
   base: '/satellite-sim/', 
   plugins: [cesium()],
  server: {
    port: 5173,
    open: true,
  },
});
