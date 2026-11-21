// SPDX-License-Identifier: Apache-2.0
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const destination = process.argv[2];
if (!destination) throw new Error('Usage: node scripts/build-public-code-worker.mjs OUTPUT_DIRECTORY');

// cf 1.0.0-beta.17 reads v0 Build Output. The artifact has no account details or secrets.
const output = resolve(destination, '.cloudflare/output/v0');
const worker = join(output, 'workers/default');
const module = 'public-code-worker.js';
await mkdir(worker, { recursive: true });
await build({
  configFile: false,
  publicDir: false,
  build: {
    ssr: fileURLToPath(new URL('../src/public-code-worker.ts', import.meta.url)),
    target: 'es2022',
    outDir: join(worker, 'bundle'),
    emptyOutDir: false,
    rollupOptions: { output: { entryFileNames: module } },
  },
});

const name = 'nanthai-forge-public-code-dev';
await writeFile(join(output, 'config.json'), JSON.stringify({ buildContext: { isPreview: false } }));
await writeFile(
  join(worker, 'worker.config.json'),
  JSON.stringify({
    name,
    compatibilityDate: '2026-10-01',
    workersDev: true,
    previewUrls: false,
    env: {
      REPLICA: { type: 'r2', name },
      FORGE_CONVEX_SITE_URL: { type: 'secret' },
      FORGE_PUBLIC_READ_SECRET: { type: 'secret' },
      FORGE_PUBLIC_CODE_WORKER_KEY: { type: 'secret' },
    },
    manifest: { type: 'complete', mainModule: module, modules: { [module]: { type: 'esm' } } },
  }),
);
