// SPDX-License-Identifier: Apache-2.0
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('.', import.meta.url));
await build({
  absWorkingDir: directory,
  entryPoints: ['worker.mjs'],
  outfile: 'dist/worker.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  external: ['node:*'],
  inject: ['inject.mjs'],
});
