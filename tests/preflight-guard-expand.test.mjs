// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 13ea93bf, expand step: the guard-set wire fields and stored fields are accepted and kept by
// today's readers and writers, before anything writes them (rollback safety; writers land next).
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { landGatesSchema, landGateTiming } from '../dist/hosted-land-gates.js';
import { hostedStartResultSchema, hostedStartSchema } from '../dist/hosted-lane.js';

const env = { ...synthetic, FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-guard-expand' };
const prior = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, env));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const GUARD = 'tests/schema-guard.test.mjs';
const laneId = '22222222-2222-4222-8222-222222222222';

test('the land gate and start formats accept the guard-set fields and work without them', () => {
  const entry = { laneId, head: 'a'.repeat(64), preflight: 'passed', saveMs: 5, preflightMs: 9 };
  const withRan = { ...entry, ran: 'AAAAB_-z', runs: 2 };
  assert.ok(landGatesSchema.safeParse({ lanes: [withRan] }).success);
  assert.ok(landGatesSchema.safeParse({ lanes: [{ ...withRan, ran: '' }] }).success, 'nothing ran');
  for (const ran of ['abc', 'AAA=', 'A'.repeat(1028)])
    assert.ok(!landGatesSchema.safeParse({ lanes: [{ ...entry, ran }] }).success, ran);
  assert.ok(!landGatesSchema.safeParse({ lanes: [{ ...entry, runs: 1000 }] }).success);
  // Timing reads the same with or without the new fields.
  assert.deepEqual(
    landGateTiming(JSON.stringify({ lanes: [withRan] })),
    landGateTiming(JSON.stringify({ lanes: [entry] })),
  );
  const start = {
    operationId: '66666666-6666-4666-8666-666666666666',
    authorityEpoch: 1,
    expectedMain: { head: 'a'.repeat(64), receiptId: 'main-0' },
    intent: { kind: 'new', outcome: 'x' },
  };
  assert.ok(hostedStartSchema.safeParse({ ...start, guardRevision: 'r1' }).success);
  assert.ok(!hostedStartSchema.safeParse({ ...start, guardRevision: 'x'.repeat(17) }).success);
  const set = {
    rev: 'r1',
    outcomes: 5,
    failed: 2,
    C: 840,
    r: 1,
    runnerMinutes: 60,
    files: [{ file: GUARD, failures: 2, checkSeconds: 2 }],
  };
  const guardSet = hostedStartResultSchema.shape.guardSet;
  assert.ok(guardSet.safeParse(set).success && guardSet.safeParse(undefined).success);
  // A malformed hint is dropped (the writer landing made this lenient), never trusted.
  assert.equal(
    guardSet.parse({ ...set, files: [{ file: '../x', failures: 2, checkSeconds: 1 }] }),
    undefined,
  );
});

test('a start that names a guard revision is the same start; only its reply carries the set', async () => {
  const channels = await import(moduleUrl('../convex/projectHostedChannels.ts'));
  const start = await import(moduleUrl('../convex/projectHostedStart.ts'));
  const s = lanesFixture();
  const head = 'a'.repeat(64);
  const projectId = s.insert('hostedProjects', {
    key: 'synthetic',
    name: 'Synthetic',
    currentBackup: null,
    revision: 0,
    owner: 'owner',
    visibility: 'private',
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  await s.call('seed', channels.seed, {
    projectId,
    actor: 'owner',
    operationId: '44444444-4444-4444-8444-444444444444',
    selection: JSON.stringify({
      schema: 2,
      projectId,
      snapshotId: '33333333-3333-4333-8333-333333333333',
      sourceRevision: 0,
      channel: 'main',
      head,
      authority: { mode: 'server', epoch: 1 },
      receipt: { id: 'main-0', kind: 'server', previousHead: null, previousReceiptId: null },
    }),
  });
  const input = {
    projectId,
    operationId: '55555555-5555-4555-8555-555555555555',
    authorityEpoch: 1,
    expectedMain: { head, receiptId: 'main-0' },
    intent: { kind: 'new', outcome: 'Guard set start' },
  };
  const first = JSON.parse(await s.call('start', start.start, { ...input, guardRevision: '' }));
  assert.ok(hostedStartResultSchema.safeParse(first).success);
  // A project with no landing outcomes yet: an empty set, still a revision to cache.
  assert.deepEqual(first.guardSet.files, []);
  // A retry of the same operation without the revision replays the same Lane: not in the payload hash.
  const retry = JSON.parse(await s.call('start', start.start, input));
  assert.equal(retry.lane.laneId, first.lane.laneId);
});

test('rows holding the new fields pass through landings, check failures and the speed record unchanged', async t => {
  const f = await batchesFixture(t, { batchMaxSize: null, count: 0, memberPaths: ['a', 'b', 'c'] });
  const settle = async failFile => {
    for (let tick = 0; tick < 900; tick++) {
      for (const run of f.runs().filter(run => run.status === 'queued' && run.gate?.mode !== 'audit'))
        if (failFile) await f.fail(run.id, failFile);
        else await f.rawChecks.pass(await f.rawChecks.activate(run.id));
      const task = f.pending().find(t => !/MainAudit:start/.test(t.name));
      if (!task) return;
      await f.execute(task);
    }
    assert.fail('tasks did not settle');
  };
  // A landing gate carrying the new fields is accepted by today's enqueue.
  await f.add(0, {
    enqueue: lane => ({
      gates: JSON.stringify({
        lanes: [{ laneId: lane.laneId, head: lane.head, preflight: 'passed', ran: '', runs: 1 }],
      }),
    }),
  });
  await settle();
  assert.deepEqual(
    states(f).map(s => s.phase),
    ['landed'],
  );
  // What the writer landing will store, as a rolled-back deployment would find it.
  const speed = [...f.tables.projectLandingSpeed.values()][0];
  const guards = JSON.stringify({ v: 1, failures: [] });
  f.patch('projectLandingSpeed', speed._id, { guards });
  await f.add(1);
  const row = [...f.tables.projectHostedLandingRequests.values()][1];
  f.patch('projectHostedLandingRequests', row._id, { preflightRan: 'AAAA', preflightRuns: 2 });
  await settle(GUARD);
  // The failure joins the document the rolled-back deployment left (preflight ran 'AAAA', not GUARD).
  const failed = [...f.tables.projectLandingSpeed.values()][0].guards;
  assert.deepEqual(
    JSON.parse(failed).failures.map(failure => failure[5].map(([file]) => file)),
    [[GUARD]],
  );
  assert.deepEqual(
    states(f).map(s => [s.phase, s.error?.code ?? null]),
    [
      ['landed', null],
      ['terminal-failed', 'CHECK_FAILED'],
    ],
  );
  // A later landing that passes rewrites the speed record through its own accept path.
  await f.add(2);
  await settle();
  const after = [...f.tables.projectLandingSpeed.values()][0];
  assert.equal(after.guards, failed, 'the accept path keeps the field');
  assert.equal([...f.tables.projectHostedLandingRequests.values()][1].preflightRan, 'AAAA');
});
