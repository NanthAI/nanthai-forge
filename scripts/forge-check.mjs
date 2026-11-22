// SPDX-License-Identifier: Apache-2.0
// The standard Forge check: install locked dependencies and select pinned verification
// with the Node that runs this script. Define it once and reuse it for every View:
//   nforge agent ROOT define-check '{"name":"verify","executable":"/abs/node","args":["scripts/forge-check.mjs"]}'
import { supportedNode, nodeRequirement } from './node-runtime.mjs';
import { execFileSync } from 'node:child_process';
import { runDocumentationChecks } from './check-documentation.mjs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/** This entry runs the definition trial (src/check-definition-trial.ts reads this line as data). */
export const CHECK_DEFINITION_TRIAL = 1;

/** Definition trial (docs/operations/github-actions-checks.md#definition-trial): main's executor already
 * ran main's plan (FORGE_ACTIONS_PLAN) on this Candidate. This runs what this tree's own definition
 * selects beyond it, with this tree's own executor. It adds tests; it never replaces main's. */
async function definitionTrial() {
  // This tree's executor loads first: a change that breaks it fails here, not on every later check.
  const { runActionsCheck } = await import('./github-actions-check.mjs');
  const { standardSelection, sourceFiles } = await import('./test-impact.mjs');
  const { browserSelection, isBrowserTest } = await import('./browser-test-policy.mjs');
  const plan = JSON.parse(readFileSync(process.env.FORGE_ACTIONS_PLAN, 'utf8'));
  const files = sourceFiles();
  const own = browserSelection(
    standardSelection({ files, env: { FORGE_CHECK_FULL: '1' } }),
    undefined,
    files,
  );
  const planned = new Set(plan.groups.flat());
  const beyond = own.tests.filter(
    test => !planned.has(test) || (isBrowserTest(test) && own.browser && !plan.selection?.browser),
  );
  const list = tests => tests.slice(0, 20).join(', ') + (tests.length > 20 ? ', ...' : '');
  console.log(
    `Definition trial: this tree's definition selects ${own.tests.length} test files; ${beyond.length} beyond main's plan${beyond.length ? `: ${list(beyond)}` : ''}.`,
  );
  // The trial runs in the browser job when main's plan has one, else in the static job, which has no
  // browser: browser tests found there are named, never run into a false red. Main's check runs them
  // once this definition is main's, and the main audit names this change if one fails. A test job
  // already built this Candidate; the static job did not.
  const build = process.env.FORGE_ACTIONS_SHARD === 'static';
  const deferred = build ? beyond.filter(isBrowserTest) : [];
  const extra = beyond.filter(test => !deferred.includes(test));
  if (deferred.length)
    console.log(
      `Definition trial: ${deferred.length} browser test file${deferred.length === 1 ? '' : 's'} not run: main's plan has no browser job. Main's check runs them after landing: ${list(deferred)}.`,
    );
  if (!extra.length) return;
  const folder = mkdtempSync(join(tmpdir(), 'forge-definition-trial-'));
  const trialPlan = join(folder, 'plan.json');
  writeFileSync(
    trialPlan,
    JSON.stringify({
      ...plan,
      pool: undefined,
      selection: {
        ...plan.selection,
        scope: 'scoped',
        reason: 'Definition trial',
        tests: extra,
        browser: own.browser && !build,
      },
      groups: [extra],
    }),
  );
  Object.assign(process.env, { FORGE_ACTIONS_PLAN: trialPlan, FORGE_ACTIONS_SHARD: '0' });
  delete process.env.FORGE_ACTIONS_POOL_PART;
  try {
    runActionsCheck(execFileSync, { install: false, build, coverage: false });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

if (process.env.FORGE_ACTIONS_PLAN) {
  // The trial child (FORGE_CHECK_TRIAL=1) is set only by the fixed supervisor, beside main's own job.
  const check =
    process.env.FORGE_CHECK_TRIAL === '1'
      ? definitionTrial
      : (await import('./github-actions-check.mjs')).runActionsCheck;
  try {
    const traceDispatch =
      process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
      process.env.GITHUB_EVENT_PATH &&
      process.env.FORGE_ACTIONS_PLAN === '.github/forge-check-plan.json' &&
      !existsSync(process.env.FORGE_ACTIONS_PLAN);
    if (!traceDispatch || !(await import('./closure-trace-check.mjs')).traceDispatchedCheck()) await check();
  } catch (error) {
    // A failed child already printed its own output; anything else would otherwise exit silently.
    if (error.status == null && !error.signal) console.error(error);
    process.exit(error.signal === 'SIGKILL' ? 137 : (error.status ?? 1));
  }
  process.exit(0);
}

const npmCli = findNpmCli();
const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}` };
const npm = (...args) => execFileSync(process.execPath, [npmCli, ...args], { env, stdio: 'inherit' });

npm('ci', '--ignore-scripts');
const { pinnedComparison, standardSelection, sourceFiles, selectTests } = await import('./test-impact.mjs');
const comparison = pinnedComparison();
let coverage;
try {
  if (env.FORGE_CHECK_COVERAGE) coverage = JSON.parse(readFileSync(env.FORGE_CHECK_COVERAGE, 'utf8'));
} catch {
  /* Missing advisory evidence uses the graph selection. */
}
const explicit = env.FORGE_SELECTED_TESTS ? JSON.parse(env.FORGE_SELECTED_TESTS) : undefined;
const files = sourceFiles();
const impact = comparison?.paths
  ? comparison.paths.length
    ? selectTests({ files, paths: comparison.paths })
    : { scope: 'none', tests: [] }
  : undefined;
env.FORGE_TEST_RETRY_FILES = JSON.stringify(
  impact && impact.scope !== 'full'
    ? [...files.keys()].filter(
        file =>
          file.startsWith('tests/') &&
          file.endsWith('.test.mjs') &&
          !impact.tests.includes(file) &&
          !comparison.paths.includes(file),
      )
    : [],
);
if (explicit?.scope === 'partial' && explicit.tests.some(path => !files.has(path)))
  throw new Error('An explicit test file is absent from the pinned source.');
const selection =
  explicit?.scope === 'partial'
    ? explicit
    : standardSelection({
        coverage,
        semanticTests: comparison?.semanticTests,
        paths: comparison?.paths,
        optimistic: comparison?.optimistic,
        recovery: comparison?.recovery,
        mainCheck: comparison?.mainCheck,
        interaction: comparison?.interaction,
        files,
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
  // The tests that read a changed document (scripts/docs-readers.mjs), the same files the hosted shards run.
  if (selection.tests.length) {
    npm('run', 'build:core');
    npm('run', 'build:web');
    execFileSync(process.execPath, ['scripts/test-files.mjs', ...selection.tests], { env, stdio: 'inherit' });
  }
} else {
  // verify reads only scope and tests; reasons can exceed Linux's per-variable limit.
  const { scope, domain, reason, tests } = selection;
  env.FORGE_SELECTED_TESTS = JSON.stringify({ scope, domain, reason, tests });
  npm('run', 'verify');
}
