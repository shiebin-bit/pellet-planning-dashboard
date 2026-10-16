import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1800 },
  server: { port: 5178, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true } } },
});
