// SPDX-License-Identifier: Apache-2.0
// Incident 5c59940b: a passed protected-path landing was held for a person (REVIEW_REQUIRED,
// phase "ready", pending waiting-for-review) while the queue dropped it and every read said
// "queued to land"; the builder cancelled it as stranded. Every read now names the hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { holdLines, landingHold } from '../dist/hosted-landing-hold.js';
import { landSummary } from '../dist/hosted-land-summary.js';
import { waitEventLine } from '../dist/hosted-wait-line.js';
import { queueStatusKey, rankQueueStatus } from '../dist/hosted-queue-status.js';
import { hostedObservationContinuation } from '../dist/hosted-agent-finish-result.js';
import { markQueueLane } from '../dist/hosted-agent-reads.js';
const view = await import(moduleUrl('../convex/projectHostedQueueView.ts'));

const LANE = '0bd3b652-58e3-4f0b-bf7f-899fab488497';
// The stored v24 of submission 24828b1f (op 0d5394e3), reduced to the fields the reads use.
const incident = {
  id: '24828b1f-9bc4-4fa6-815a-de200ecaa7d3',
  operationId: '0d5394e3-4ccf-4cdc-964e-0df73decfacc',
  projectId: 'p',
  actor: 'owner',
  sequence: 857,
  version: 24,
  phase: 'ready',
  observation: { state: 'pending', pendingReason: 'waiting-for-review', cause: null },
  error: {
    code: 'REVIEW_REQUIRED',
    message: 'Waiting for review by a person; protected paths: .github/workflows/forge-check.yml',
  },
};

test('a review hold names its reason, protected paths and next step from the state in hand', () => {
  const hold = landingHold(incident, LANE);
  assert.equal(hold.kind, 'review');
  assert.deepEqual(hold.paths, ['.github/workflows/forge-check.yml']);
  assert.match(hold.reason, /protected paths: \.github\/workflows\/forge-check\.yml/);
  assert.match(hold.next, /owner accepts submission 24828b1f-9bc4-4fa6-815a-de200ecaa7d3 as a person/);
  assert.match(hold.next, new RegExp(`land --withdraw '\\{"laneId":"${LANE}"\\}'`));
  // The owner's link comes from approve-link on this exact operation (fe5bea80).
  assert.match(hold.next, /approve-link '\{"operationId":"0d5394e3-4ccf-4cdc-964e-0df73decfacc"\}'/);
  // A builder's approval request after protected paths: the paths still parse.
  const requested = landingHold({
    ...incident,
    error: {
      code: 'REVIEW_REQUIRED',
      message: 'needs owner approval: protected paths a.yml; approval requested on Lane 0bd3b652: billing',
    },
  });
  assert.deepEqual(requested.paths, ['a.yml']);
  assert.match(requested.reason, /approval requested on Lane 0bd3b652: billing/);
  // Public-governance wording, several paths, no Lane known.
  const governed = landingHold({
    ...incident,
    error: { code: 'REVIEW_REQUIRED', message: 'needs owner approval: protected paths a.yml, b/c.ts' },
  });
  assert.deepEqual(governed.paths, ['a.yml', 'b/c.ts']);
  assert.match(governed.next, /"laneId":"LANE_ID"/);
  // A hold that names no paths says so with null, never a guess.
  const supervised = landingHold({ ...incident, error: null });
  assert.equal(supervised.paths, null);
  assert.equal(supervised.reason, 'Waiting for review by a person');
  assert.equal(
    landingHold({ ...incident, observation: { state: 'pending', pendingReason: 'waiting-for-dependency' } })
      .kind,
    'dependency',
  );
  for (const pendingReason of ['queued', 'checking', null])
    assert.equal(landingHold({ ...incident, observation: { state: 'pending', pendingReason } }), null);
  assert.equal(landingHold({ ...incident, observation: { state: 'terminal-failed' } }), null);
});

test('land and wait summaries say WAITING FOR REVIEW, never "queued to land", for a held passed landing', () => {
  const lines = landSummary({ result: { submission: incident, replayParameters: { laneId: LANE } } });
  assert.match(lines[0], /^WAITING FOR REVIEW; not landed yet: .*\.github\/workflows\/forge-check\.yml/);
  assert.match(lines[1], new RegExp(LANE));
  assert(!lines.join('\n').includes('queued to land'), lines.join('\n'));
  // An unheld passed entry keeps its existing line.
  const ready = { ...incident, observation: { state: 'pending', pendingReason: 'queued' }, error: null };
  assert.match(landSummary({ result: { submission: ready } })[0], /CHECK PASSED; queued to land/);
  assert.deepEqual(holdLines(landingHold(incident, LANE)), lines);
  // The compact wait line carries the hold; an unheld one carries none.
  const line = waitEventLine({ type: 'submission', operationId: incident.operationId, submission: incident });
  assert.equal(line.line.hold.kind, 'review');
  assert.deepEqual(line.line.hold.paths, ['.github/workflows/forge-check.yml']);
  assert.equal(waitEventLine({ type: 'submission', submission: ready }).line.hold, undefined);
  // status {operationId}/observe and land receipts: the hold rides beside the wait continuation.
  const reply = hostedObservationContinuation('/tmp/root', { submission: incident });
  assert.equal(reply.hold.kind, 'review');
  assert.match(reply.waitCommand, /wait/);
});

test('the queue directory keeps held entries, outside dispatch order and never as a predecessor', () => {
  const key = queueStatusKey(incident);
  assert(key, 'a held pending landing keeps a directory entry');
  assert.equal(key.held, 'review');
  const queued = (id, sequence) => ({ id, sequence, actor: 'a', priority: 'normal', phase: 'queued' });
  const ranked = rankQueueStatus([queued('q2', 900), key, queued('q1', 858)]);
  assert.deepEqual(
    ranked.order.map(k => k.id),
    ['q1', 'q2', incident.id],
  );
  assert.equal(ranked.active, 2);
  assert.equal(ranked.held, 1);
  assert.equal(ranked.groups, 2);
  const held = ranked.order.at(-1);
  assert.equal(held.position, undefined);
  assert.equal(held.group, undefined);
  assert.equal(held.predecessor, undefined);
  assert(
    ranked.order.every(k => k.predecessor !== incident.id),
    'nothing waits behind a held entry',
  );
  assert.equal(queueStatusKey({ ...incident, phase: 'landed', observation: { state: 'landed' } }), null);
});

const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test('incident replay: a protected-path landing held for review stays listed in queue with its hold', async t => {
  Object.assign(process.env, synthetic);
  t.after(() => {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  // The policy is in place before the submissions pin it (the dogfood project's protected list).
  const f = await batchesFixture(t, {
    count: 0,
    batching: false,
    memberPaths: ['.github/workflows/forge-check.yml', 'member-1'],
  });
  const current = f.tables.hostedProjects.get(f.projectId).autonomyPolicy;
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...current,
      acceptance: { ...current.acceptance, protectedPaths: ['.github/workflows/**'] },
    },
  });
  await f.add(0);
  await f.add(1);
  for (let round = 0; round < 4; round++) {
    await f.drain();
    await f.passChecks();
  }
  await f.drain();
  const held = states(f).find(s => s.observation.pendingReason === 'waiting-for-review');
  assert(held, JSON.stringify(states(f).map(s => [s.phase, s.error])));
  assert.equal(held.error.code, 'REVIEW_REQUIRED');
  assert.match(held.error.message, /\.github\/workflows\/forge-check\.yml/);
  const page = JSON.parse(await f.c.run('queueView', view.read, { projectId: f.projectId }));
  const entry = page.entries.find(e => e.submissionId === held.id);
  assert(entry, `held entry is listed: ${JSON.stringify(page)}`);
  assert.equal(entry.position, null);
  assert.equal(entry.hold.kind, 'review');
  assert.deepEqual(entry.hold.paths, ['.github/workflows/forge-check.yml']);
  assert.match(entry.hold.next, /owner accepts/);
  assert.equal(page.held, 1);
  // The builder's queue read: yourLane is listed and names the hold.
  const marked = markQueueLane(page, entry.laneId);
  assert.equal(marked.yourLane.listed, true);
  assert.equal(marked.yourLane.entries[0].hold.kind, 'review');
});

test('status {laneId}: this machine remembers the last observed hold, and clears it once unheld', async t => {
  const state = mkdtempSync(join(tmpdir(), 'forge-hold-'));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = state;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(state, { recursive: true, force: true });
  });
  const registry = await import('../dist/lane-registry.js');
  registry.recordLane({ laneId: LANE, root: '/tmp/lane', url: 'u', projectId: 'p' });
  const hold = landingHold(incident, LANE);
  registry.recordLaneHold(LANE, incident.operationId, hold);
  const live = registry.laneLiveness(LANE);
  assert.equal(live.landingHold.kind, 'review');
  assert.equal(live.landingHold.operationId, incident.operationId);
  assert.deepEqual(live.landingHold.paths, ['.github/workflows/forge-check.yml']);
  // Another operation's clear leaves this hold; its own clear removes it.
  registry.recordLaneHold(LANE, '11111111-1111-4111-8111-111111111111', null);
  assert(registry.laneLiveness(LANE).landingHold);
  registry.recordLaneHold(LANE, incident.operationId, null);
  assert.equal(registry.laneLiveness(LANE).landingHold, undefined);
});
