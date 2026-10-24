// SPDX-License-Identifier: Apache-2.0
// Queue this command as a recorded Forge check on the historical View being measured.
// Its explicit argument is the immutable comparison, not paths from a mutable checkout.
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { selectTests, sourceFiles } from './test-impact.mjs';
const comparison = JSON.parse(process.argv[2]);
if (!comparison.base || !comparison.head || !Array.isArray(comparison.paths))
  throw new Error('Expected pinned comparison');
const started = Date.now();
const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` };
execFileSync(process.execPath, ['/usr/local/lib/node_modules/npm/bin/npm-cli.js', 'ci', '--ignore-scripts'], {
  env,
  stdio: 'inherit',
});
const selection = selectTests({
  paths: comparison.paths,
  files: sourceFiles(),
  forceFull: env.FORGE_CHECK_FULL === '1',
});
console.log(JSON.stringify({ comparison, selection }));
if (process.env.FORGE_CHECK_SELECTION)
  writeFileSync(process.env.FORGE_CHECK_SELECTION, JSON.stringify(selection));
execFileSync(process.execPath, [fileURLToPath(new URL('./verify.mjs', import.meta.url))], {
  env: { ...env, FORGE_SELECTED_TESTS: JSON.stringify(selection) },
  stdio: 'inherit',
});
console.log(
  JSON.stringify({
    measurement: 'impact-replay',
    seconds: (Date.now() - started) / 1000,
    files: selection.tests.length,
    scope: selection.scope,
  }),
);
