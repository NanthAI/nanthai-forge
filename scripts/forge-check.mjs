// SPDX-License-Identifier: Apache-2.0
// The standard Forge check: install locked dependencies and select pinned verification
// with the Node that runs this script. Define it once and reuse it for every View:
//   nforge agent ROOT define-check '{"name":"verify","executable":"/abs/node","args":["scripts/forge-check.mjs"]}'
import { supportedNode, nodeRequirement } from './node-runtime.mjs';
import { execFileSync } from 'node:child_process';
import { runDocumentationChecks } from './check-documentation.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

if (!supportedNode()) throw Object.assign(new Error(nodeRequirement), { code: 'UNSUPPORTED_NODE' });

function findNpmCli() {
  const candidates = [
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
    '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js',
  ];
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const shim = join(dir, 'npm');
    if (existsSync(shim)) candidates.push(join(dirname(realpathSync(shim)), 'npm-cli.js'));
  }
  const found = candidates.find(path => existsSync(path));
  if (!found) throw new Error('npm-cli.js not found; install npm alongside the check Node.');
  return found;
}

if (process.env.FORGE_ACTIONS_PLAN) {
  const { runActionsCheck } = await import('./github-actions-check.mjs');
  try {
    runActionsCheck();
  } catch (error) {
    // A failed child already printed its own output; anything else would otherwise exit silently.
    if (error.status === undefined && !error.signal) console.error(error);
    process.exit(error.signal === 'SIGKILL' ? 137 : (error.status ?? 1));
  }
  process.exit(0);
}

const npmCli = findNpmCli();
const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}` };
const npm = (...args) => execFileSync(process.execPath, [npmCli, ...args], { env, stdio: 'inherit' });

npm('ci', '--ignore-scripts');
const { pinnedComparison, standardSelection, sourceFiles } = await import('./test-impact.mjs');
const comparison = pinnedComparison();
let coverage;
try {
  if (env.FORGE_CHECK_COVERAGE) coverage = JSON.parse(readFileSync(env.FORGE_CHECK_COVERAGE, 'utf8'));
} catch {
  /* Missing advisory evidence uses the graph selection. */
}
const selection = standardSelection({
  coverage,
  paths: comparison?.paths,
  optimistic: comparison?.optimistic,
  recovery: comparison?.recovery,
  mainCheck: comparison?.mainCheck,
  interaction: comparison?.interaction,
  files: sourceFiles(),
});
if (env.FORGE_CHECK_DOCS_ADMISSION === '1' && selection.scope !== 'docs')
  throw new Error(
    'Docs admission classification changed; no heavyweight verification started. Retry through ordinary check admission.',
  );
console.log(`Check selection: ${selection.scope}; ${selection.reason}; ${selection.tests.length} test files`);
console.log(JSON.stringify(selection));
if (process.env.FORGE_CHECK_SELECTION)
  writeFileSync(process.env.FORGE_CHECK_SELECTION, JSON.stringify(selection));
if (selection.scope === 'docs') {
  runDocumentationChecks({
    npm,
    node: script => execFileSync(process.execPath, [script], { env, stdio: 'inherit' }),
    interaction: comparison?.interaction !== undefined,
  });
} else {
  // verify reads only scope and tests; reasons can exceed Linux's per-variable limit.
  const { scope, domain, reason, tests } = selection;
  env.FORGE_SELECTED_TESTS = JSON.stringify({ scope, domain, reason, tests });
  npm('run', 'verify');
}
