import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { llmDocuments } from '../scripts/llm-documents.mjs';
export default defineConfig({
  base: '/',
  envDir: '..',
  plugins: [
    {
      name: 'forge-public-documentation',
      apply: 'build',
      generateBundle() {
        for (const asset of llmDocuments(fileURLToPath(new URL('../', import.meta.url))))
          this.emitFile({ type: 'asset', ...asset });
      },
    },
  ],
  worker: { format: 'es' },
  build: { outDir: '../hosted-web-dist', emptyOutDir: true },
});
