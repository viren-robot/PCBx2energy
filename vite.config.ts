import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 1600, target: 'es2022' },
});
