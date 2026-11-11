// SPDX-License-Identifier: Apache-2.0
import { build } from 'vite';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Avoid loading the schema module graph on every edit; keep it lazy in the worker.
const result = await build({
  configFile: false,
  publicDir: false,
  build: {
    ssr: 'src/agent-edit-hook.ts',
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2022',
    rollupOptions: {
      output: {
        entryFileNames: 'agent-edit-hook.js',
        chunkFileNames: 'agent-edit-hook-[name]-[hash:8].js',
      },
    },
  },
  ssr: { noExternal: true },
});

// dist also holds tsc and CLI output. Retire only obsolete hashed hook chunks, after a
// successful build, so repeated builds keep one current graph without erasing their siblings.
const emitted = new Set([result].flat().flatMap(bundle => bundle.output.map(file => file.fileName)));
for (const name of readdirSync('dist'))
  if (/^agent-edit-hook-.+-[\w-]{8}\.js(?:\.map)?$/.test(name) && !emitted.has(name))
    rmSync(join('dist', name));
