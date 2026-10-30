import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { llmDocuments } from '../scripts/llm-documents.mjs';
export default defineConfig({
  base: '/',
  envDir: '..',
  plugins: [
    {
      // Vite silently swaps a Node builtin for an empty stub in the browser; a chunk that then calls
      // createRequire() fails at load and the whole app shows "Could not load Forge." (2026-10-28).
      name: 'forge-no-node-in-browser',
      apply: 'build',
      enforce: 'pre',
      resolveId(id, importer) {
        const name = id.replace(/^node:/, '').split('/')[0];
        if (
          importer &&
          !importer.includes('/node_modules/') &&
          (id.startsWith('node:') || builtinModules.includes(name))
        )
          this.error(
            `Browser code must not import the Node builtin "${id}" (from ${importer}). ` +
              'Move the Node-only code into its own module that web/src does not reach.',
          );
      },
    },
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
  build: { outDir: '../hosted-web-dist', emptyOutDir: true, manifest: true },
});
