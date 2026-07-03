import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';

const base = '/satellite-sim/';

export default defineConfig({
  base,
  plugins: [
    cesium(),
    {
      name: 'inject-cesium-base-url',
      transformIndexHtml: {
        order: 'pre',
        handler(html) {
          const script = `<script>window.CESIUM_BASE_URL = ${JSON.stringify(`${base}cesium/`)};</script>`;
          return html.replace('<head>', `<head>\n    ${script}`);
        },
      },
    },
  ],
  server: {
    port: 5173,
    open: true,
  },
});
