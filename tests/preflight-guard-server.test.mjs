// SPDX-License-Identifier: Apache-2.0
// Item 13ea93bf, server half: the land gate's `ran` rides on the landing row; only a failed check reads
// it and writes the project's guard document; a Lane start's reply computes the candidates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { ranEvidence } from '../dist/preflight-guard-learning.js';

const env = { ...synthetic, FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-guard-set' };
const prior = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, env));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const GUARD = 'tests/schema-guard.test.mjs';
const { guardSetReply } = await import(moduleUrl('../convex/projectLandingSpeed.ts'));

async function settle(f, failFile) {
  for (let tick = 0; tick < 900; tick++) {
    for (const run of f.runs().filter(run => run.status === 'queued' && run.gate?.mode !== 'audit'))
      if (failFile) {
        // The builder waits a minute for the verdict, so the failure has a cost (C).
        f.advanceClock(60_000);
        await f.fail(run.id, failFile);
      } else await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    const task = f.pending().find(t => !/MainAudit:start/.test(t.name));
    if (!task) return;
    await f.execute(task);
  }
  assert.fail('tasks did not settle');
}
/** The gate the CLI sends for the Lane it lands: what its preflight ran, and its local runs. */
const gated = ran => lane => ({
  gates: JSON.stringify({
    lanes: [
      {
        laneId: lane.laneId,
        head: lane.head,
        preflight: 'passed',
        ...(ran === undefined ? {} : { ran }),
        runs: 2,
      },
    ],
  }),
});

test('a failed check learns the test files its preflight skipped; landings and covered files teach nothing', async t => {
  const f = await batchesFixture(t, { batchMaxSize: null, count: 0 });
  const speedRow = () => [...f.tables.projectLandingSpeed.values()][0];
  const reply = known =>
    f.tx('guardSetReply', { _handler: ctx => guardSetReply(ctx, f.projectId, known) }, {});
  const row = n => [...f.tables.projectHostedLandingRequests.values()][n];
  // Five landings that pass: the speed record holds them, and its guard field stays unwritten.
  for (const i of [0, 1, 2, 3, 4]) {
    await f.add(i, { enqueue: gated(ranEvidence([])) });
    await settle(f);
  }
  assert.deepEqual(new Set(states(f).map(s => s.phase)), new Set(['landed']));
  assert.equal(speedRow().guards, undefined, 'a landing writes nothing new');
  assert.equal(row(0).preflightRan, '', 'the gate evidence rides on the landing row');
  assert.equal(row(0).preflightRuns, 2);

  // Two failed checks of a test file preflight did not run: the file becomes a candidate.
  for (const i of [5, 6]) {
    await f.add(i, { enqueue: gated(ranEvidence(['tests/other.test.mjs'])) });
    await settle(f, GUARD);
  }
  assert.deepEqual(
    states(f)
      .slice(5)
      .map(s => [s.phase, s.error?.code]),
    [
      ['terminal-failed', 'CHECK_FAILED'],
      ['terminal-failed', 'CHECK_FAILED'],
    ],
  );
  const doc = JSON.parse(speedRow().guards);
  assert.deepEqual(
    doc.failures.map(failure => [failure[4], failure[5].map(([file]) => file)]),
    [
      [2, [GUARD]],
      [2, [GUARD]],
    ],
  );
  const set = await reply('');
  assert.ok(set.C > 0, 'a real failed landing costs its builder wait');
  assert.deepEqual(
    {
      outcomes: set.outcomes,
      failed: set.failed,
      r: set.r,
      files: set.files.map(file => [file.file, file.failures]),
    },
    { outcomes: 7, failed: 2, r: 2, files: [[GUARD, 2]] },
  );
  // The caller already holds this revision: the reply carries nothing.
  assert.equal(await reply(set.rev), null);

  // Preflight ran the file and the check still failed it: not a selection miss. An older CLI that
  // sent no `ran`: a failed outcome that teaches no file.
  await f.add(7, { enqueue: gated(ranEvidence([GUARD])) });
  await settle(f, GUARD);
  await f.add(8, { enqueue: gated(undefined) });
  await settle(f, GUARD);
  const after = await reply(set.rev);
  assert.deepEqual(
    {
      outcomes: after.outcomes,
      failed: after.failed,
      files: after.files.map(file => [file.file, file.failures]),
    },
    { outcomes: 9, failed: 4, files: [[GUARD, 2]] },
  );

  // A garbage guard document fails neither a landing nor a failure: the next failure starts it over.
  speedRow().guards = '{not json';
  assert.deepEqual((await reply('')).files, []);
  await f.add(9, { enqueue: gated(ranEvidence([])) });
  await settle(f, GUARD);
  await f.add(10, { enqueue: gated(ranEvidence([])) });
  await settle(f);
  assert.deepEqual(
    states(f)
      .slice(9)
      .map(s => [s.phase, s.error?.code]),
    [
      ['terminal-failed', 'CHECK_FAILED'],
      ['landed', undefined],
    ],
  );
  assert.deepEqual(
    JSON.parse(speedRow().guards).failures.map(failure => failure[5].map(([file]) => file)),
    [[GUARD]],
  );
});

test('a Lane start delivers the project candidates only to a CLI that asks, and only when they changed', async () => {
  const { lanesFixture } = await import('./hosted-lanes-fixture.mjs');
  const channels = await import(moduleUrl('../convex/projectHostedChannels.ts'));
  const start = await import(moduleUrl('../convex/projectHostedStart.ts'));
  const { hostedStartResultSchema } = await import('../dist/hosted-lane.js');
  const { addGuardFailure } = await import('../dist/preflight-guard-learning.js');
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
  const main = {
    schema: 2,
    projectId,
    snapshotId: '33333333-3333-4333-8333-333333333333',
    sourceRevision: 0,
    channel: 'main',
    head,
    authority: { mode: 'server', epoch: 1 },
    receipt: { id: 'main-0', kind: 'server', previousHead: null, previousReceiptId: null },
  };
  await s.call('seed', channels.seed, {
    projectId,
    actor: 'owner',
    operationId: '44444444-4444-4444-8444-444444444444',
    selection: JSON.stringify(main),
  });
  const failed = id => ({ id, testFiles: { failed: [{ file: GUARD, report: { durationMs: 2000 } }] } });
  const now = Date.now();
  const guards = addGuardFailure(
    addGuardFailure(undefined, failed('f1'), { ran: '' }, now - 2),
    failed('f2'),
    { ran: '' },
    now - 1,
  );
  const samples = [0, 1, 2, 3, 4].map(i => [now - 100 - i, 1, 1, `landed-${i}`]);
  const speed = s.insert('projectLandingSpeed', {
    projectId,
    value: JSON.stringify({ schema: 2, samples, broken: {} }),
    guards,
  });
  let n = 0;
  const begin = extra =>
    s
      .call('start', start.start, {
        projectId,
        operationId: `55555555-5555-4555-8555-55555555555${n++}`,
        authorityEpoch: 1,
        expectedMain: { head, receiptId: 'main-0' },
        intent: { kind: 'new', outcome: 'Guard set start' },
        ...extra,
      })
      .then(JSON.parse);
  // An older CLI never sends a revision and never sees the field (strict replies).
  assert.equal((await begin({})).guardSet, undefined);
  const first = await begin({ guardRevision: '' });
  assert.ok(hostedStartResultSchema.safeParse(first).success);
  assert.deepEqual(
    first.guardSet.files.map(file => [file.file, file.failures, file.checkSeconds]),
    [[GUARD, 2, 2]],
  );
  // The CLI holds that revision now: the next start carries nothing.
  assert.equal((await begin({ guardRevision: first.guardSet.rev })).guardSet, undefined);
  // A garbage guard document never fails a start: the reply carries an empty set.
  s.patch('projectLandingSpeed', speed, { guards: '{not json' });
  const garbage = await begin({ guardRevision: first.guardSet.rev });
  assert.ok(hostedStartResultSchema.safeParse(garbage).success);
  assert.deepEqual(garbage.guardSet.files, []);
});
