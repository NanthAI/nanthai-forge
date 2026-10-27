// SPDX-License-Identifier: Apache-2.0
import { build } from 'vite';

// Avoid loading the schema module graph on every edit; keep it lazy in the worker.
await build({
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
        chunkFileNames: 'agent-edit-hook-[name]-[hash].js',
      },
    },
  },
  ssr: { noExternal: true },
});
