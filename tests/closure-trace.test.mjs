// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { closureDispatch, closurePlan } from '../scripts/closure-trace-check.mjs';
import { closureTraceChild, collectClosureTrace, digest } from '../scripts/closure-trace-output.mjs';
import { temporaryDirectory } from '../scripts/test-temp.mjs';

test('only a dedicated closure dispatch selects the full inventory and assigns every test once', () => {
  const { publicKey } = generateKeyPairSync('x25519');
  const traceKey = publicKey.export({ format: 'jwk' }).x;
  assert.equal(closureDispatch({ inputs: { runId: 'regular-run', deployment: 'hosted' } }), null);
  assert.deepEqual(closureDispatch({ inputs: { runId: `closure-trace-a-${traceKey}`, plan: '[0,1]' } }), {
    count: 2,
    traceKey,
  });
  assert.throws(
    () => closureDispatch({ inputs: { runId: `closure-trace-a-${traceKey}`, plan: '[0,2]' } }),
    /consecutive/,
  );
  const tests = ['tests/a.test.mjs', 'tests/b.test.mjs', 'tests/docs-site.test.mjs'];
  const plan = closurePlan(tests, 2);
  assert.equal(plan.selection.scope, 'full');
  assert.equal(plan.selection.browser, true);
  assert.deepEqual(plan.groups.flat().sort(), tests);
});

test('test preload records loaded functions, fixture reads, missing paths and descendant reads', t => {
  const root = temporaryDirectory(t, 'forge-closure-fixture-');
  const script = `import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
function covered() { return readdirSync('nested', { recursive: true, withFileTypes: true }); }
function unused() { throw new Error('unreachable'); }
covered();
await readFile('fixture.txt');
await readFile('absent.txt').catch(() => {});
const { stdout } = await promisify(execFile)(process.execPath, ['child.mjs']);
if (stdout.trim() !== 'child finished') throw new Error('promisified execFile lost its stdout result');
`;
  writeFileSync(join(root, 'entry.mjs'), script);
  writeFileSync(
    join(root, 'child.mjs'),
    "import { readFileSync } from 'node:fs'; readFileSync('child.txt'); console.log('child finished');",
  );
  mkdirSync(join(root, 'nested', 'leaf'), { recursive: true });
  writeFileSync(join(root, 'fixture.txt'), 'fixture');
  writeFileSync(join(root, 'child.txt'), 'child');
  const childEnv = { ...process.env };
  const folder = closureTraceChild(root, childEnv);
  childEnv.FORGE_CLOSURE_TRACE_ROOT = pathToFileURL(root).href;
  const result = spawnSync(process.execPath, ['entry.mjs'], { cwd: root, env: childEnv, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const rows = readdirSync(folder).map(name => JSON.parse(readFileSync(join(folder, name), 'utf8')));
  const entry = rows.find(row => row.inputs.module.includes('entry.mjs'));
  const child = rows.find(row => row.inputs.module.includes('child.mjs'));
  assert.ok(entry.inputs.read.includes('fixture.txt'));
  assert.ok(entry.inputs.missing.includes('absent.txt'));
  assert.ok(entry.inputs.list.some(value => value.startsWith('nested\0recursive\0')));
  assert.ok(child.inputs.read.includes('child.txt'));
  const [, hash, offsets] = entry.functions.find(([path]) => path === 'entry.mjs');
  assert.equal(hash, digest(script));
  assert.ok(offsets.some(offset => Number(offset.split(':')[0]) === script.indexOf('function covered')));
  assert.ok(!offsets.some(offset => Number(offset.split(':')[0]) === script.indexOf('function unused')));
});

test('V8 snapshots preserve calls before and after an existing coverage reset', t => {
  const root = realpathSync(temporaryDirectory(t, 'forge-closure-snapshot-'));
  const script = `import { takeCoverage } from 'node:v8';
function before() { return 1; }
function after() { return 2; }
before();
takeCoverage();
after();
`;
  writeFileSync(join(root, 'entry.mjs'), script);
  const childEnv = { ...process.env };
  const folder = closureTraceChild(root, childEnv, true);
  childEnv.FORGE_CLOSURE_TRACE_ROOT = pathToFileURL(root).href;
  const result = spawnSync(process.execPath, ['entry.mjs'], { cwd: root, env: childEnv, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const row = collectClosureTrace(folder, 'entry.mjs', root);
  assert.equal(row.complete, true);
  const [, , offsets] = row.functions.find(([name]) => name === 'entry.mjs');
  assert.ok(offsets.some(offset => Number(offset.split(':')[0]) === script.indexOf('function before')));
  assert.ok(offsets.some(offset => Number(offset.split(':')[0]) === script.indexOf('function after')));
});
