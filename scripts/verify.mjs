// SPDX-License-Identifier: Apache-2.0
// Verification with independent static steps running concurrently. Direct runs test
// every file; the standard check can supply a pinned impact selection. Tests start
// after their builds, streaming counts while static-step diagnostics stay buffered.
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { commandQueue } from './verify-queue.mjs';
import { workerBudget } from '../tests/worker-budget.mjs';
import { fileTimeout } from './test-files.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { prepareConvexApi } from './prepare-convex-api.mjs';

// Prepare once before parallel compilers; this file is deliberately not tracked.
prepareConvexApi(fileURLToPath(new URL('../', import.meta.url)));

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
  if (!found) throw new Error('npm-cli.js not found; install npm alongside the Node running verify.');
  return found;
}

const npmCli = findNpmCli();
// Local Git commands in tests get a load-tolerant ceiling: several checks routinely share one machine.
const env = {
  FORGE_GIT_TIMEOUT_MS: '240000',
  ...process.env,
  PATH: `${dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}`,
};
const started = Date.now();
const timings = [];
let outOfMemory = false;
const selection = process.env.FORGE_SELECTED_TESTS ? JSON.parse(process.env.FORGE_SELECTED_TESTS) : null;
console.log(
  `Verification: ${selection?.scope ?? 'full'}; ${selection?.reason ?? 'Direct verify runs the full suite'}`,
);

const schedule = commandQueue(process.env.FORGE_STATIC_WORKERS);
function run(name, command, args) {
  return schedule(() => runCommand(name, command, args));
}

function runCommand(name, command, args) {
  const begin = Date.now();
  return new Promise(resolve => {
    const child = spawn(command, args, {
      env: name === 'test' ? { ...env, FORGE_TEST_DIAGNOSTICS: '1', FORGE_TEST_EVENTS: '1' } : env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [],
      failures = [];
    const decoder = new StringDecoder('utf8');
    let pending = '',
      completed = 0,
      failed = 0;
    child.stdout.on('data', chunk => {
      if (name !== 'test') {
        chunks.push(chunk);
        return;
      }
      pending += decoder.write(chunk);
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const raw of lines) {
        if (raw.startsWith('# Flaky test file:')) {
          process.stdout.write(`[test] ${raw.slice(2)}\n`);
          continue;
        }
        if (raw.startsWith('__FORGE_COVERAGE__') || raw.startsWith('__FORGE_TESTS__')) {
          process.stdout.write(`${raw}\n`);
          continue;
        }
        if (raw.startsWith('__FORGE_TEST_FAILURE__')) {
          const failure = JSON.parse(raw.slice('__FORGE_TEST_FAILURE__'.length));
          process.stdout.write(`[test] Failed test file: ${failure.file}\n${failure.output}\n`);
          continue;
        }
        chunks.push(Buffer.from(`${raw}\n`));
        const line = raw.trimStart();
        if (/^(?:ok|not ok) (?:\d+|-)/.test(line)) {
          completed++;
          if (line.startsWith('not ok')) {
            failed++;
            failures.push(line);
            process.stdout.write(`[test] ${line}\n`);
          }
          process.stdout.write(`[test] completed=${completed} failed=${failed}\n`);
        }
      }
    });
    child.stderr.on('data', chunk => chunks.push(chunk));
    child.once('error', error => {
      chunks.push(Buffer.from(String(error)));
      finish(1);
    });
    child.once('close', (code, signal) => finish(signal === 'SIGKILL' ? 137 : (code ?? 1)));
    let finished = false;
    function finish(code) {
      if (finished) return;
      finished = true;
      pending += decoder.end();
      if (pending) chunks.push(Buffer.from(pending));
      if (code === 137) outOfMemory = true;
      const seconds = ((Date.now() - begin) / 1000).toFixed(1);
      timings.push(`${code === 0 ? 'ok  ' : 'FAIL'} ${seconds.padStart(6)}s  ${name}`);
      // Passing steps print one line; a failing step prints everything it said.
      if (code === 0) {
        const summary = Buffer.concat(chunks)
          .toString()
          .split('\n')
          .filter(line => /^(?:ℹ |# )(tests|pass|fail|cancelled|skipped|todo) /.test(line));
        process.stdout.write(`[${name}] ok (${seconds}s)\n${summary.map(line => `  ${line}\n`).join('')}`);
      } else {
        process.stdout.write(`[${name}] FAILED (${seconds}s)\n${Buffer.concat(chunks)}\n`);
        // Repeat early failure names at the tail for bounded run-summary readers.
        for (const line of failures) process.stdout.write(`[test] ${line}\n`);
      }
      resolve(code === 0);
    }
  });
}
const npm = (name, ...args) => run(name, process.execPath, [npmCli, 'run', '--silent', ...args]);
const tsc = (name, ...args) => {
  // Web retains tsc 5; Convex also checks compatibility with the runtime TypeScript dependency.
  const legacy = name === 'typecheck:web' || name === 'typecheck:convex:tsc';
  return run(name, process.execPath, [
    join('node_modules', legacy ? 'typescript' : '@typescript/native', 'bin', 'tsc'),
    ...(legacy ? [] : ['--noUncheckedSideEffectImports', 'false']),
    ...args,
  ]);
};

// Tests and the Convex compatibility check wait for core emit. The hosted web build
// runs alongside them; no test reads its output.
const coreBuild = npm('build:core', 'build:core');
const convexCompatibility = coreBuild.then(
  ok => ok && tsc('typecheck:convex:tsc', '-p', 'convex/tsconfig.json', '--noEmit'),
);
const build = Promise.all([coreBuild, npm('build:web', 'build:web')]).then(results => results.every(Boolean));
const tests = coreBuild.then(ok => {
  if (!ok) return false;
  // Longest files first so the slowest ones never start last and set the tail. Order only; every file runs.
  const slowest = [
    'git-http',
    'native-git-contributions',
    'native-pr',
    'native-git-http',
    'mirrors',
    'hosted-work',
    'playbooks',
    'mcp',
    'hosted-work-index',
    'native-contributions',
    'evidence',
  ].map(name => `${name}.test.mjs`);
  const rank = name => (slowest.includes(name) ? slowest.indexOf(name) : slowest.length);
  const files =
    selection?.scope === 'partial'
      ? selection.tests
      : readdirSync('tests')
          .filter(
            name =>
              name.endsWith('.test.mjs') && (!selection || selection.tests.includes(join('tests', name))),
          )
          .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1))
          .map(name => join('tests', name));
  // Budget test files explicitly: concurrent recorded verifies already share this machine.
  // Fixture queues stay private; no correctness test loses its own queue overrides.
  const workers = workerBudget(env);
  console.log(`Test workers: ${workers} (FORGE_TEST_WORKERS overrides the default)`);
  console.log(`Test file timeout: ${fileTimeout(env)}ms (FORGE_TEST_FILE_TIMEOUT_MS overrides it)`);
  if ((!selection || selection.scope === 'full') && env.FORGE_CHECK_HEAD)
    env.FORGE_TEST_COVERAGE_HEAD = env.FORGE_CHECK_HEAD;
  return run('test', process.execPath, [
    fileURLToPath(new URL('./test-files.mjs', import.meta.url)),
    ...files,
  ]);
});
const results = await Promise.all([
  npm('check', 'check'),
  run('documents', process.execPath, ['scripts/check-documents.mjs']),
  run('schema compatibility', process.execPath, ['scripts/check-schema-compat.mjs']),
  run('format:check (oxfmt)', process.execPath, ['scripts/oxc.mjs', 'format:check']),
  tsc('typecheck:core', '--types', '*', '--noEmit'),
  tsc('typecheck:web', '-p', 'web/tsconfig.json'),
  tsc('typecheck:convex', '--types', '*', '-p', 'convex/tsconfig.json', '--noEmit'),
  tsc('typecheck:netlify', '-p', 'netlify/tsconfig.json'),
  convexCompatibility,
  run('lint (oxlint)', process.execPath, ['scripts/oxc.mjs', 'lint']),
  build,
]);
const testPassed = await tests;
// Packaging rebuilds dist from scratch. Wait for every build, compiler and test
// before exercising the installed archive, for local and Actions checks.
if (results.every(Boolean)) results.push(await npm('smoke:package', 'smoke:package'));
console.log(`\n${timings.join('\n')}\ntotal ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`__FORGE_STATIC__${JSON.stringify({ passed: results.every(Boolean) })}`);
process.exit(results.every(Boolean) && testPassed ? 0 : outOfMemory ? 137 : 1);
