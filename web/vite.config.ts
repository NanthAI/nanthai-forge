// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import optimizeLocales from '@react-aria/optimize-locales-plugin';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { llmDocuments, llmsFullSizeReport } from '../scripts/llm-documents.mjs';
import { LAYER_GZIP_BUDGET, layerBundleReport, layerImportViolation } from '../scripts/ds-build-guard.mjs';
// Two pages: index.html is the static public page (no app code), app.html the signed-in app. On the dev and preview
// servers every other page route serves app.html, as netlify.toml does in production.
type Middlewares = { middlewares: { use: (fn: AppRoute) => unknown } };
const appRoutes = {
  name: 'forge-app-routes',
  // A hook that returns a function would run it as a post hook, so these return nothing.
  configureServer(server: Middlewares) {
    server.middlewares.use(appRoute);
  },
  configurePreviewServer(server: Middlewares) {
    server.middlewares.use(appRoute);
  },
};
type AppRoute = (req: { url?: string; headers: { accept?: string } }, res: unknown, next: () => void) => void;
function appRoute(req: Parameters<AppRoute>[0], _res: unknown, next: () => void) {
  const url = new URL(req.url ?? '/', 'http://forge.invalid');
  const page =
    url.pathname !== '/' &&
    url.pathname !== '/index.html' &&
    !/^\/(?:@|src\/|node_modules\/|assets\/)/.test(url.pathname) &&
    !/\.[a-z0-9]+$/i.test(url.pathname) &&
    (req.headers.accept ?? '').includes('text/html');
  if (page) req.url = `/app.html${url.search}`;
  next();
}
export default defineConfig({
  base: '/',
  envDir: '..',
  plugins: [
    // React Fast Refresh: an edit updates the component in place and keeps its state (Item 6ebb58ab measured the loop).
    react(),
    // The design system's behaviour layer keeps only its en-US messages (Item 6ebb58ab).
    { ...optimizeLocales.vite({ locales: ['en-US'] }), enforce: 'pre' },
    {
      // One behaviour layer: imported only by web/src/ds/behaviour, no second behaviour or drag library, never in the
      // first-paint chunks, and inside its byte budget (scripts/ds-build-guard.mjs).
      name: 'forge-ds-layer',
      enforce: 'pre',
      resolveId(id: string, importer?: string) {
        const problem = layerImportViolation(id, importer);
        if (problem) this.error(problem);
        return null;
      },
      generateBundle(_options: unknown, bundle: Record<string, unknown>) {
        const { problems, layer } = layerBundleReport(bundle, LAYER_GZIP_BUDGET);
        for (const problem of problems) this.error(problem);
        if (layer)
          this.info(
            `design-system behaviour layer: ${layer.gzipBytes} of ${LAYER_GZIP_BUDGET} gzip bytes in ${layer.files.length} chunks`,
          );
      },
    },
    appRoutes,
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
        const assets = llmDocuments(fileURLToPath(new URL('../', import.meta.url)));
        // Size is reported, never a build failure: Lanes that each fit alone must also land together.
        const report = llmsFullSizeReport(assets.find(asset => asset.fileName === 'llms-full.txt').source);
        if (report.warn) this.warn(report.message);
        else this.info(report.message);
        for (const asset of assets) this.emitFile({ type: 'asset', ...asset });
      },
    },
  ],
  worker: { format: 'es' },
  build: {
    outDir: '../hosted-web-dist',
    emptyOutDir: true,
    manifest: true,
    rolldownOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        app: fileURLToPath(new URL('./app.html', import.meta.url)),
      },
    },
  },
});
