import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import pkg from './package.json' with { type: 'json' };

// In a browser (development) /api and /ws go to a local am-server started
// with tls.mode = "off": AM_DEV_SERVER=127.0.0.1:8443 npm run dev
const devServer = process.env.AM_DEV_SERVER ?? '127.0.0.1:8443';
// Optional second local server, reached under /s2 (to try things across servers).
const devServer2 = process.env.AM_DEV_SERVER2 ?? '';
const proxy = {
  '/api': { target: `http://${devServer}`, changeOrigin: true },
  '/ws': { target: `ws://${devServer}`, ws: true },
  ...(devServer2 && {
    '/s2/api': { target: `http://${devServer2}`, changeOrigin: true, rewrite: (p: string) => p.slice(3) },
    '/s2/ws': { target: `ws://${devServer2}`, ws: true, rewrite: (p: string) => p.slice(3) },
  }),
};

// Tauri expects a fixed dev port and serves the built files from dist/.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  clearScreen: false,
  define: { __APP_VERSION__: JSON.stringify(process.env.AM_VERSION ?? pkg.version), __AM_DEV_SERVER2__: JSON.stringify(devServer2) },
  server: {
    port: 1420,
    strictPort: true,
    proxy,
  },
  preview: { proxy },
  build: { target: 'es2022', outDir: 'dist' },
});
