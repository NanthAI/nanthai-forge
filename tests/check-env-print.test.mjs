// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { envPrintFindings } from '../scripts/check-env-print.mjs';

// Synthetic names only: no fixture holds a real environment value.
const lines = (path, text) => envPrintFindings(path, text).map(finding => Number(finding.split(':')[1]));

test('incident replay 2026-10-22: process listings and env dumps in scripts fail', () => {
  const script = [
    "import { execFileSync, execSync } from 'node:child_process';",
    "execFileSync('pgrep', ['-fl', 'convex'], { stdio: 'inherit' });",
    "execSync('npx convex env list | grep SYNTHETIC_KEY');",
    "execSync('ps -E -p 123');",
    "execFileSync('ps', ['-E', '-p', '123']);",
    "execFileSync('printenv', ['SYNTHETIC_KEY']);",
    "execFileSync('env', []);",
  ].join('\n');
  assert.deepEqual(lines('scripts/debug-worker.mjs', script), [2, 3, 4, 5, 6, 7]);
  const shell = 'pgrep -lf convex\nenv | sort\nps auxeww\nprintenv\nps -axo pid=,comm=\n';
  assert.deepEqual(lines('scripts/debug.sh', shell), [1, 2, 3, 4]);
  const finding = envPrintFindings('scripts/debug.sh', 'env | grep SYNTHETIC_KEY\n')[0];
  assert.match(finding, /^scripts\/debug\.sh:1: prints environment values/);
  assert.ok(!finding.includes('SYNTHETIC_KEY'), 'findings never echo the matched text');
});

test('printing process.env values fails; name-only reads pass', () => {
  const code = [
    'console.log(process.env);',
    'console.error(process.env.SYNTHETIC_KEY);',
    "process.stdout.write(process.env['SYNTHETIC_KEY']);",
    'console.log(JSON.stringify(process.env, null, 2));',
    'console.log(Object.keys(process.env).sort().join("\\n"));',
    'const key = process.env.SYNTHETIC_KEY;',
    "spawnSync('env', ['SYNTHETIC=1', 'node', 'x.mjs']);",
  ].join('\n');
  assert.deepEqual(lines('src/debug.ts', code), [1, 2, 3, 4]);
});

test('docs fail when they instruct the commands and pass when they forbid them', () => {
  const doc = [
    'Find the worker with `pgrep -fl node`.',
    '```sh',
    'npx convex env list',
    'env',
    '# never run printenv here',
    'nforge status',
    '```',
    'Do not run `npx convex env list`, `env`, `printenv`, `pgrep -fl` or `ps -E`, even through filters.',
    "Set the check definition's `env` passthrough. It runs eventually ps listing jobs.",
    'Run `env` to see the values.',
    '```js',
    'console.log(process.env.SYNTHETIC_KEY);',
    '```',
  ].join('\n');
  assert.deepEqual(lines('docs/operations.md', doc), [1, 3, 4, 10, 12]);
  // An ellipsis inside a forbidding sentence does not split it.
  assert.deepEqual(
    lines('AGENTS.md', 'Safety needs "never print ... secrets" plus `npx convex env list`.\n'),
    [],
  );
});

test('YAML run lines are checked; env blocks are not commands', () => {
  const workflow = 'jobs:\n  a:\n    env:\n      NAME: x\n    steps:\n      - run: env | sort\n';
  assert.deepEqual(lines('.github/workflows/ci.yml', workflow), [6]);
});

test('markers, the allowlist and synthetic tests are exempt; other paths are not', () => {
  const marked = '// forge-env-print: name-only\nconsole.log(process.env.SYNTHETIC_NAME_LIST);\n';
  assert.deepEqual(envPrintFindings('scripts/names.mjs', marked), []);
  assert.deepEqual(envPrintFindings('scripts/check-env-print.mjs', 'console.log(process.env);'), []);
  assert.deepEqual(envPrintFindings('tests/example.test.mjs', 'console.log(process.env);'), []);
  assert.equal(envPrintFindings('README.md', 'Run `printenv` first.').length, 1);
  assert.deepEqual(envPrintFindings('scripts/data.json', '{"run":"printenv"}'), []);
});

test('friction 9ed03b2b: `env` as an identifier in a code span is not the env command; real command positions still are', () => {
  const doc = [
    'Run the loader with `load(env)` and read `type Mode = "ci" | env | "local"` for the modes.', // identifiers
    'Run `env` to see the values.',
    'Run `echo go; env` once.',
    'Run `cat names | env` once.',
    'Run `make $(env)` once.',
    'Run `a && env` once.',
  ].join('\n');
  assert.deepEqual(lines('docs/operations.md', doc), [2, 3, 4, 5, 6]);
  const shell = ['foo(env)', 'x | env', 'env | sort', 'FOO=1 true; env'].join('\n');
  assert.deepEqual(lines('scripts/debug.sh', shell), [3, 4]);
});
