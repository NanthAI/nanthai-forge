// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { digest } from '../dist/hash.js';
import { savedChangedPaths } from '../dist/hosted-changed-paths.js';
import { preflightPlan, readPreflightReceipt } from '../dist/agent-preflight.js';
import { effectiveAgentDefaults } from '../dist/agent-parallel-defaults.js';
import { clientCacheRoot } from '../dist/root-paths.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function fixture(t) {
  const f = agentFixture(t);
  const put = bytes => {
    const id = digest(bytes);
    f.objects.set(id, bytes);
    return id;
  };
  const state = files =>
    put(
      Buffer.from(
        JSON.stringify({
          schema: 1,
          kind: 'forge-source-state',
          parents: [],
          files: files.map(([path, text]) => ({ path, blob: put(Buffer.from(text)), mode: 'file' })),
          at: '2026-01-01T00:00:00.000Z',
          message: 'Synthetic',
        }),
      ),
    );
  // A sync head: it carries main's change to b.ts and a new c.ts, drops d.ts, keeps a.ts and its
  // Node test (which, in a Node project with a package.json, names the project's test runner).
  const base = state([
    ['package.json', '{}'],
    ['src/a.ts', 'a'],
    ['tests/a.test.mjs', "import '../src/a.ts';"],
    ['src/b.ts', 'b1'],
    ['src/d.ts', 'd'],
  ]);
  const head = state([
    ['package.json', '{}'],
    ['src/a.ts', 'a'],
    ['tests/a.test.mjs', "import '../src/a.ts';"],
    ['src/b.ts', 'b2'],
    ['src/c.ts', 'c'],
  ]);
  // Current main carries b2 too: that path is main's change merged into the Lane, not the Lane's.
  const main = state([
    ['package.json', '{}'],
    ['src/a.ts', 'a'],
    ['tests/a.test.mjs', "import '../src/a.ts';"],
    ['src/b.ts', 'b2'],
    ['src/d.ts', 'd'],
  ]);
  return { f, base, head, main };
}

test('a sync head without a saved delta projection gets its exact own paths from the pinned manifests', async t => {
  const { f, base, head, main } = fixture(t);
  f.main.head = main;
  const transport = f.transport();
  const before = f.calls.length;
  const result = await savedChangedPaths(transport, { base, head }, { paths: [], complete: false });
  // b.ts equals current main (merged in); c.ts is added and d.ts deleted by the Lane.
  assert.deepEqual(result, { paths: ['src/c.ts', 'src/d.ts'], complete: true, source: 'manifests' });
  const calls = f.calls.slice(before);
  assert(calls.length <= 2, `one main read and one bounded object page, saw ${calls.length}`);
  assert(calls.every(call => call.args.digests === undefined || call.args.digests.length <= 3));
  const again = f.calls.length;
  await savedChangedPaths(transport, { base, head }, { paths: [], complete: false });
  assert.equal(f.calls.length - again, 1, 'pinned manifests are cached: a repeat reads only main');
});

test('an unreadable main keeps the exact base-to-head superset', async t => {
  const { f, base, head } = fixture(t);
  const transport = f.transport();
  const query = transport.query.bind(transport);
  transport.query = async (name, args) => {
    if (name === 'projectHostedChannels:current') throw new Error('unavailable');
    return query(name, args);
  };
  const result = await savedChangedPaths(transport, { base, head }, { paths: [], complete: false });
  assert.deepEqual(result.paths, ['src/b.ts', 'src/c.ts', 'src/d.ts']);
});

test('a complete projection costs nothing, and an unreadable source stays unknown', async t => {
  const { f, base, head } = fixture(t);
  const transport = f.transport();
  const before = f.calls.length;
  assert.deepEqual(
    await savedChangedPaths(transport, { base, head }, { paths: ['src/b.ts'], complete: true }),
    {
      paths: ['src/b.ts'],
      complete: true,
      source: 'projection',
    },
  );
  assert.equal(f.calls.length, before, 'idle path makes no calls');
  f.allow(false);
  const unknown = { paths: [], complete: false };
  assert.equal(
    await savedChangedPaths(transport, { base: 'f'.repeat(64), head: 'e'.repeat(64) }, unknown),
    unknown,
    'a missing observation never becomes "no changes"',
  );
});

test('preflight selects from manifest-derived paths and says where they came from', t => {
  const plan = preflightPlan(
    '/nonexistent-forge-root',
    { paths: ['docs/x.md'], complete: true, source: 'manifests' },
    undefined,
  );
  assert.equal(plan.status, 'planned');
  assert.equal(plan.changedPathsFrom, 'manifests');
  assert.equal(
    preflightPlan('/nonexistent-forge-root', { paths: [], complete: false }).status,
    'unavailable',
  );
});

test('plan-only preflight on a sync head derives paths, starts no build or test and records no receipt', async t => {
  const { f, base, head } = fixture(t);
  f.main.head = base;
  f.lane.base.head = base;
  f.lane.head = head;
  f.caps.agentDefaults = effectiveAgentDefaults();
  const transport = f.transport();
  await transport.dispatch('open', { laneId: f.lane.laneId });
  // The fixture serves no saved path projection: the server answer is "unknown", as after a sync.
  const response = await transport.dispatch('preflight', { laneId: f.lane.laneId, run: false });
  assert.equal(response.result.plan.status, 'planned');
  assert.equal(response.result.plan.changedPathsFrom, 'manifests');
  assert.equal(response.result.receipt, undefined, 'plan-only never runs');
  assert.equal(readPreflightReceipt(f.root, f.lane.laneId), null, 'plan-only records nothing');
  assert(
    f.calls.every(call => !/Landing|Finish|Check/.test(call.name)),
    'plan-only starts no landing or check',
  );
});

test('preflight "retry":true plans exactly the files the last run stopped for time', async t => {
  const f = agentFixture(t);
  const put = bytes => {
    const id = digest(bytes);
    f.objects.set(id, bytes);
    return id;
  };
  const state = files =>
    put(
      Buffer.from(
        JSON.stringify({
          schema: 1,
          kind: 'forge-source-state',
          parents: [],
          files: files.map(([path, text]) => ({ path, blob: put(Buffer.from(text)), mode: 'file' })),
          at: '2026-01-01T00:00:00.000Z',
          message: 'Synthetic',
        }),
      ),
    );
  const tests = [
    ['package.json', '{}'],
    ['scripts/forge-check.mjs', ''],
    ['tests/a.test.mjs', "import '../src/a.ts';"],
    ['tests/b.test.mjs', "import '../src/a.ts';"],
  ];
  const base = state([['src/a.ts', 'export const n = 1;'], ...tests]);
  f.main.head = base;
  f.lane.base.head = base;
  f.lane.head = state([['src/a.ts', 'export const n = 2;'], ...tests]);
  f.caps.agentDefaults = effectiveAgentDefaults();
  const transport = f.transport();
  await transport.dispatch('open', { laneId: f.lane.laneId });
  const laneId = f.lane.laneId;
  await assert.rejects(
    transport.dispatch('preflight', { laneId, retry: true, run: false }),
    error => error.code === 'BAD_ARGUMENT' && /stopped no file for time/.test(error.message),
  );
  const receipt = {
    schema: 1,
    laneId,
    head: f.lane.head,
    tests: 1,
    selection: 'local',
    exitCode: 0,
    passed: true,
    durationMs: 1,
    at: '2026-01-01T00:00:00.000Z',
    stoppedForTime: 1,
    stopped: ['tests/b.test.mjs'],
  };
  const path = join(clientCacheRoot(f.root), 'agent', 'preflight', `${laneId}.json`);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(receipt));
  const response = await transport.dispatch('preflight', { laneId, retry: true, run: false });
  assert.deepEqual(response.result.plan.tests, ['tests/b.test.mjs']);
  assert.ok(response.result.plan.deferredTests.includes('tests/a.test.mjs'));
});
