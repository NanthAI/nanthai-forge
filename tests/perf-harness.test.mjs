// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { measurement, eagerFiles, landingTiming } from '../scripts/perf/report.mjs';
import { options } from '../scripts/perf-harness.mjs';
import { successfulSample } from '../scripts/perf/browser.mjs';

test('budget medians include the boundary, and an empty or incomplete run never passes', () => {
  assert.equal(measurement('now', [{ durationMs: 1500 }]).status, 'pass');
  assert.equal(measurement('now', [{ durationMs: 1501 }]).status, 'fail');
  assert.equal(measurement('now', []).status, 'unrun');
  for (const durationMs of [null, NaN, -1, Infinity]) {
    const row = measurement('now', [{ durationMs: 1 }, { durationMs }]);
    assert.equal(row.status, 'failed');
    assert.equal(row.medianMs, null);
  }
  assert.equal(measurement('oneFilePush', [{ durationMs: 3 }, { durationMs: 1 }]).medianMs, 2);
});

test('bundle accounting follows shared static imports once and excludes dynamic route chunks', () => {
  const manifest = {
    entry: { file: 'main.js', imports: ['shared'], dynamicImports: ['route'] },
    shared: { file: 'shared.js', imports: ['entry'], css: ['shared.css'] },
    route: { file: 'route.js', imports: ['shared'] },
  };
  assert.deepEqual(eagerFiles(manifest, ['entry']), ['main.js', 'shared.css', 'shared.js']);
  assert.deepEqual(eagerFiles(manifest, ['entry', 'route']), [
    'main.js',
    'route.js',
    'shared.css',
    'shared.js',
  ]);
  assert.throws(() => eagerFiles(manifest, ['absent']), /PERF_MANIFEST_ENTRY/);
});

const at = seconds => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
const work = () => ({
  intents: [{ id: 'intent', createdAt: at(0) }],
  views: [{ id: 'view', intentId: 'intent', head: 'exact', at: at(20) }],
  channelMoves: [
    { id: 'pending', status: 'pending', viewId: 'view', channel: 'main', head: 'exact', at: at(50) },
    { id: 'accepted', status: 'accepted', viewId: 'view', channel: 'main', head: 'exact', at: at(40) },
  ],
  runs: [
    {
      id: 'run',
      viewId: 'view',
      head: 'exact',
      status: 'passed',
      queuedAt: at(21),
      startedAt: at(23),
      endedAt: at(35),
    },
    { id: 'other-head', viewId: 'view', head: 'stale', status: 'passed' },
  ],
});

test('landing times retain exact source and distinguish author lifetime, composition, queue and run', () => {
  const data = work(),
    before = structuredClone(data),
    result = landingTiming(data);
  assert.equal(result.intentToAcceptMs, 40000);
  assert.equal(result.composeToAcceptMs, 20000);
  assert.equal(result.finishCommandMs, null);
  assert.deepEqual(
    result.runs.map(r => [r.id, r.queueMs, r.runMs]),
    [['run', 2000, 12000]],
  );
  assert.equal(result.head, 'exact');
  assert.deepEqual(data, before);
});

test('missing records, wrong exact head or invalid dates cannot manufacture a landing duration', () => {
  assert.equal(landingTiming(work(), 'absent').status, 'unrun');
  const missing = work();
  missing.views[0].head = 'different';
  assert.equal(landingTiming(missing).status, 'unrun');
  const badDate = work();
  badDate.intents[0].createdAt = 'invalid';
  assert.equal(landingTiming(badDate).status, 'failed');
  const noQueue = work();
  delete noQueue.runs[0].queuedAt;
  assert.equal(landingTiming(noQueue).runs[0].queueMs, null);
});

test('browser result rejects error-ready markers, missing diffs, signed-out pages and wrong routes', () => {
  const good = {
    authenticated: true,
    routeMatches: true,
    runtimeError: false,
    hasAlert: false,
    hasDiff: true,
    mark: { complete: 950, queries: { sourceDiff: 900 } },
  };
  assert.equal(successfulSample(good, 'laneFirstDiff'), true);
  for (const change of [
    { authenticated: false },
    { routeMatches: false },
    { runtimeError: true },
    { hasAlert: true },
    { hasDiff: false },
    { mark: { complete: 950, queries: {} } },
    { mark: { complete: null } },
  ])
    assert.equal(successfulSample({ ...good, ...change }, 'laneFirstDiff'), false);
});

test('arguments keep live measurement explicit and reject invalid timing or credential-bearing URLs', () => {
  assert.equal(options([]).live, false);
  assert.throws(() => options(['--live']));
  assert.throws(() => options(['--samples', '0']));
  assert.throws(() => options(['--samples', '1.5']));
  assert.throws(() => options(['--live', '--base', 'https://user:password@example.invalid']));
  assert.throws(() => options(['--landing-id', 'not-selected']));
});

async function run(t, extra = []) {
  const directory = mkdtempSync(resolve('node_modules/perf-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const output = join(directory, 'result.json');
  const child = spawn(
    process.execPath,
    [
      'scripts/perf-harness.mjs',
      '--samples',
      '1',
      '--out',
      output,
      '--credentials',
      join(directory, 'absent-credentials'),
      ...extra,
    ],
    {
      env: { ...process.env, FORGE_AUTH_TOKEN: 'synthetic-redaction-sentinel' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let text = '';
  child.stdout.on('data', b => (text += b));
  child.stderr.on('data', b => (text += b));
  const code = await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('close', done);
  });
  const json = readFileSync(output, 'utf8');
  assert.doesNotMatch(json + text, /synthetic-redaction-sentinel|synthetic-only|Authorization|Bearer/);
  assert.equal(statSync(output).mode & 0o777, 0o600);
  return { code, record: JSON.parse(json) };
}

test('one command records machine/build identity and explicitly unrun retired push and browser results', async t => {
  const { code, record } = await run(t);
  const push = record.measurements.oneFilePush;
  assert.deepEqual(push.samples, []);
  assert.equal(push.status, 'unrun');
  assert.equal(push.medianMs, null);
  assert.match(push.reason, /Exchange push was retired/);
  assert.equal(code, 0);
  assert.equal(record.status, 'partial');
  for (const name of ['now', 'work', 'laneFirstDiff'])
    assert.equal(record.measurements[name].status, 'unrun');
  assert.equal(record.landing.status, 'unrun');
  assert.match(record.buildHash, /^[a-f0-9]{64}$/);
  assert.ok(record.machine.cpuCount > 0);
  assert.ok(Date.parse(record.endedAt) >= Date.parse(record.startedAt));
  assert.equal(record.syntheticFixture, undefined);
});

test('requested live setup failure still writes JSON and returns a failure, never a successful live sample', async t => {
  const { code, record } = await run(t, ['--live', '--base', 'http://127.0.0.1:1']);
  assert.equal(code, 1);
  assert.equal(record.status, 'fail');
  assert.equal(record.browser.status, 'failed');
  assert.equal(record.measurements.now.status, 'unrun');
  assert.equal(record.measurements.now.medianMs, null);
});
