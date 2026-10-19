import { defineConfig } from 'vite';
export default defineConfig({
  base: '/',
  envDir: '..',
  worker: { format: 'es' },
  build: { outDir: '../hosted-web-dist', emptyOutDir: true },
});
