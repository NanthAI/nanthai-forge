// SPDX-License-Identifier: Apache-2.0
import { observerProjectionBudget } from './observer-projection-budget.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { landingFixture } from './hosted-landing-fixture.mjs';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/state/hash.js';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { queuedConflict } from '../dist/hosted-agent-finish.js';
import { observeHostedSubmissions } from '../dist/hosted-agent-submission-wait.js';
import { normalizeHostedFinishResult } from '../dist/hosted-agent-finish-result.js';
import { landSummary } from '../dist/hosted-land-summary.js';
import { landWaitContinuation } from '../dist/hosted-land-wait.js';

const wouldConflict = await import(moduleUrl('../convex/projectHostedLandingWouldConflict.ts'));
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
const queueView = await import(moduleUrl('../convex/projectHostedQueueView.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** A copy of the fixture Candidate that records the paths it changes, as composition does. */
function candidateWithPaths(f, paths) {
  const base = f.request().candidateId;
  const source = [...f.tables.projectHostedRecords.values()].find(
    r => r.kind === 'candidate' && r.key === base,
  );
  const body = f.tables.projectHostedRecordBodies.get(source.bodyId);
  const id = randomUUID();
  const value = canonicalPayload({
    ...JSON.parse(body.value),
    id,
    governance: { version: 1, paths, ownerInputs: false },
  });
  const bodyId = f.insert('projectHostedRecordBodies', { ...stripSystem(body), value });
  const { _id, _creationTime, ...record } = source;
  void _id;
  void _creationTime;
  const recordId = f.insert('projectHostedRecords', {
    ...record,
    key: id,
    bodyId,
    digest: digest(value),
    bytes: Buffer.byteLength(value),
  });
  const head = [...f.tables.projectHostedRecordHeads.values()].find(
    r => r.kind === 'candidate' && r.key === base,
  );
  f.insert('projectHostedRecordHeads', { ...stripSystem(head), key: id, recordId });
  return id;
}
const stripSystem = row => Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith('_')));
const rowOf = (f, id) => [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === id);
/** One pass with main's merge lists already read (main declares none unless given). */
const mark = (f, paths, landedSubmissionId, declared = { union: [], fragments: [] }) =>
  f.run('wouldConflict', (ctx, input) => wouldConflict.markWouldConflict(ctx, input), {
    projectId: f.projectId,
    paths,
    landedSubmissionId,
    declared,
  });

test('incident replay 2026-10-30 cost builder: a stale queued Candidate is marked wouldConflict when main lands its file', async () => {
  const f = await landingFixture();
  // The cost builder's Candidate queued behind a landing that changes the same file.
  const landing = await f.enqueue(
    f.request({ candidateId: candidateWithPaths(f, ['convex/cost.ts', 'docs/a.md']) }),
  );
  const stale = await f.enqueue(
    f.request({ candidateId: candidateWithPaths(f, ['convex/cost.ts', 'src/x.ts']) }),
  );
  const unrelated = await f.enqueue(f.request({ candidateId: candidateWithPaths(f, ['web/app.tsx']) }));
  const checking = await f.enqueue(f.request({ candidateId: candidateWithPaths(f, ['convex/cost.ts']) }));
  f.patch('projectHostedLandingRequests', rowOf(f, checking.id)._id, { runId: 'run-1' });
  const before = f.counts.length;
  assert.equal(await mark(f, ['convex/cost.ts', 'docs/a.md'], landing.id), 1);
  const marked = JSON.parse(rowOf(f, stale.id).wouldConflict);
  assert.deepEqual(marked.paths, ['convex/cost.ts']);
  assert.equal(marked.landedSubmissionId, landing.id);
  assert.match(marked.next, /^SYNC_REQUIRED: .*Do not keep waiting.*land --save/);
  assert.equal(rowOf(f, unrelated.id).wouldConflict, undefined, 'no shared path');
  assert.equal(rowOf(f, checking.id).wouldConflict, undefined, 'already checked against a pinned main');
  assert.equal(rowOf(f, landing.id).wouldConflict, undefined, 'the landing itself');
  const cost = f.counts.slice(before).find(c => c.name === 'wouldConflict');
  assert(
    cost.documents <= 20 + 3 * 3,
    `one bounded queue read plus three reads per Candidate: ${cost.documents}`,
  );
  assert.equal(observerProjectionBudget(cost).writes, 1);
  // The stale entry's receipt says so; others do not.
  const status = await f.status(stale.id);
  assert.deepEqual(status.wouldConflict, marked);
  assert.equal((await f.status(unrelated.id)).wouldConflict, undefined);
  // Marking twice changes nothing.
  assert.equal(await mark(f, ['convex/cost.ts'], landing.id), 0);
  assert.equal(rowOf(f, stale.id).wouldConflict, canonicalPayload(marked));
});

test('shared Markdown docs are not sync-required advice: the recompose merges them (Issue 561996ac)', async () => {
  const f = await landingFixture();
  const landing = await f.enqueue(
    f.request({ candidateId: candidateWithPaths(f, ['docs/status.md', 'README.md', 'src/y.ts']) }),
  );
  const docsOnly = await f.enqueue(
    f.request({ candidateId: candidateWithPaths(f, ['docs/status.md', 'README.md']) }),
  );
  const mixed = await f.enqueue(
    f.request({ candidateId: candidateWithPaths(f, ['docs/status.md', 'src/y.ts']) }),
  );
  const nested = await f.enqueue(f.request({ candidateId: candidateWithPaths(f, ['src/notes.md']) }));
  assert.equal(await mark(f, ['docs/status.md', 'README.md', 'src/y.ts', 'src/notes.md'], landing.id), 2);
  assert.equal(rowOf(f, docsOnly.id).wouldConflict, undefined);
  assert.deepEqual(JSON.parse(rowOf(f, mixed.id).wouldConflict).paths, ['src/y.ts']);
  // Markdown outside docs/ and the root is not documentation scope, as in native finish.
  assert.deepEqual(JSON.parse(rowOf(f, nested.id).wouldConflict).paths, ['src/notes.md']);
});

test("files main's forge.json declares as merged lists are not sync-required advice; the one config read is an action (Issue 853fcde3)", async () => {
  const f = await landingFixture();
  const landing = await f.enqueue(
    f.request({ candidateId: candidateWithPaths(f, ['lists/owners.txt', 'src/z.ts']) }),
  );
  const listOnly = await f.enqueue(f.request({ candidateId: candidateWithPaths(f, ['lists/owners.txt']) }));
  const mixed = await f.enqueue(
    f.request({ candidateId: candidateWithPaths(f, ['lists/owners.txt', 'src/z.ts']) }),
  );
  // A mutation cannot read main's forge.json: the first entry that would be marked hands the pass
  // to the action, which reads main's State and forge.json off the landing write.
  const paths = ['lists/owners.txt', 'src/z.ts'];
  const first = await f.run('wouldConflict', (ctx, input) => wouldConflict.markWouldConflict(ctx, input), {
    projectId: f.projectId,
    paths,
    landedSubmissionId: landing.id,
  });
  assert.equal(first, 0, 'nothing marked before the config read');
  const handoff = f.pendingTasks().filter(t => t.name === 'projectHostedConflictMerge:wouldConflictConfig');
  assert.equal(handoff.length, 1);
  assert.deepEqual(handoff[0].args[0], { projectId: f.projectId, paths, landedSubmissionId: landing.id });
  assert.equal(rowOf(f, mixed.id).wouldConflict, undefined);
  // The action calls back with main's merge lists.
  const marked = await mark(f, paths, landing.id, { union: ['lists/*.txt'], fragments: [] });
  assert.equal(marked, 1);
  assert.equal(rowOf(f, listOnly.id).wouldConflict, undefined, 'the declared list merges on recompose');
  assert.deepEqual(JSON.parse(rowOf(f, mixed.id).wouldConflict).paths, ['src/z.ts']);
});

test('a landing with no known paths schedules nothing; publication stays constant-size', async () => {
  const f = await landingFixture();
  const state = await f.enqueue();
  const tasks = () =>
    f.pendingTasks().filter(t => t.name === 'projectHostedLandingWouldConflict:mark').length;
  await f.run('schedule', (ctx, input) => wouldConflict.scheduleWouldConflict(ctx, input), {
    projectId: f.projectId,
    paths: null,
    landedSubmissionId: state.id,
  });
  assert.equal(tasks(), 0);
  await f.run('schedule', (ctx, input) => wouldConflict.scheduleWouldConflict(ctx, input), {
    projectId: f.projectId,
    paths: ['a.ts'],
    landedSubmissionId: state.id,
  });
  assert.equal(tasks(), 1, 'one scheduled pass per land with paths');
});

test('dogfood-scale budget: 60 queued entries cost one bounded scan and at most 10 Candidate reads', async () => {
  const f = await landingFixture();
  const landed = await f.enqueue();
  const shared = candidateWithPaths(f, ['convex/cost.ts']);
  for (let i = 0; i < 60; i++) await f.enqueue(f.request({ candidateId: shared }));
  const before = f.counts.length;
  const marked = await mark(f, ['convex/cost.ts'], landed.id);
  assert.equal(marked, wouldConflict.WOULD_CONFLICT_READS);
  const cost = f.counts.slice(before).find(c => c.name === 'wouldConflict');
  const source = observerProjectionBudget(cost);
  assert(source.ranges <= 1 + 3 * wouldConflict.WOULD_CONFLICT_READS, `ranges ${cost.ranges}`);
  assert(source.documents <= wouldConflict.WOULD_CONFLICT_SCAN + 3 * wouldConflict.WOULD_CONFLICT_READS);
  assert.equal(source.writes, marked);
});

test('a replay of the queued land names its one continuation; reads only when queued', async () => {
  const reads = [];
  const laneId = randomUUID();
  const at = new Date().toISOString();
  const queued = { id: 'sub-1', operationId: 'op-1', phase: 'queued', observation: { state: 'pending' } };
  let advice = {
    paths: ['convex/cost.ts'],
    more: 0,
    landedSubmissionId: randomUUID(),
    laneId,
    at,
    next: 'SYNC_REQUIRED',
  };
  const session = {
    root: '/work/lane',
    query: async (name, args) => {
      reads.push([name, args]);
      return { wouldConflict: advice };
    },
  };
  // Main already took its file (f7539ebb): the continuation is the same Lane's land --save, not a wait.
  const replay = await queuedConflict(session, queued);
  assert.equal(replay.code, 'SYNC_REQUIRED');
  assert.deepEqual(replay.next, { action: 'land', save: true, laneId });
  assert.equal(replay.nextCommand, `nforge agent '/work/lane' land --save '{"laneId":"${laneId}"}'`);
  assert.equal(replay.command, replay.nextCommand);
  assert.deepEqual(reads, [['projectHostedLanding:status', { submissionId: 'sub-1' }]]);
  // A predecessor's speculative conflict needs no agent action: it keeps the canonical wait.
  advice = {
    code: 'COMPOSITION_CONFLICT',
    predecessor: {
      groupId: randomUUID(),
      submissionId: randomUUID(),
      head: 'a'.repeat(64),
      receiptId: randomUUID(),
    },
    paths: ['convex/cost.ts'],
    more: 0,
    at,
    next: 'No agent action is needed.',
  };
  const speculative = await queuedConflict(session, queued);
  assert.deepEqual(speculative.next, { action: 'wait', operationIds: ['op-1'] });
  assert.equal(speculative.nextCommand, `nforge agent '/work/lane' wait '{"operationIds":["op-1"]}'`);
  reads.length = 1;
  assert.deepEqual(await queuedConflict(session, { id: 'sub-1', phase: 'checking' }), {});
  assert.equal(reads.length, 1, 'no read past the queue');
  const failing = { ...session, query: async () => Promise.reject(new Error('offline')) };
  assert.deepEqual(await queuedConflict(failing, { id: 'sub-1', phase: 'queued' }), {}, 'advisory only');
});

test('incident replay 2026-11-09 D1: a queued landing whose file main changed returns SYNC_REQUIRED within one poll, and wait, observe, queue and land agree', async () => {
  const f = await landingFixture();
  // D1 queued behind a landing that also changes a shared module. (The incident's shared file was
  // docs/agents/workflow.md; shared Markdown docs are now merged by the recompose, Issue 561996ac.)
  const ahead = await f.enqueue(
    f.request({ candidateId: candidateWithPaths(f, ['src/agent-workflow.ts', 'src/ahead.ts']) }),
  );
  const d1 = await f.enqueue(
    f.request({
      candidateId: candidateWithPaths(f, ['src/agent-workflow.ts', 'src/d1.ts']),
      message: 'D1: tighten workflow docs',
    }),
  );
  let reads = 0;
  const subscriptions = new Set();
  const page = args =>
    f.call('syncPage', observe.page, { ...args, projectId: f.projectId }, 'owner').then(JSON.parse);
  const transport = {
    root: '/work/root',
    address: { url: 'https://fixture.invalid', projectId: f.projectId },
    dispatch: async () => ({
      schema: 1,
      transport: 'hosted',
      action: 'capabilities',
      operationId: null,
      result: { actor: 'owner' },
    }),
    query: async (name, args) => {
      assert.equal(name, 'projectHostedFinishObserve:page');
      reads++;
      return page(args);
    },
  };
  const subscribe = () => ({
    onUpdate(_ref, _args, next) {
      const s = { next };
      subscriptions.add(s);
      return () => subscriptions.delete(s);
    },
    async close() {},
  });
  const waiting = observeHostedSubmissions(
    transport,
    { operationIds: [d1.operationId], until: 'acceptance', timeoutSeconds: 30 },
    undefined,
    () => {},
    subscribe,
  );
  for (let i = 0; i < 1000 && !subscriptions.size; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(subscriptions.size, 1, 'the wait is live on the queued entry');
  const before = reads;
  // Main lands the overlapping path; the existing event-driven mark records it.
  assert.equal(await mark(f, ['src/agent-workflow.ts', 'src/ahead.ts'], ahead.id), 1);
  for (const s of subscriptions) s.next(null); // the subscription's one wake
  const waited = await waiting;
  assert.equal(reads - before, 1, 'SYNC_REQUIRED within one poll, no extra read');
  assert.equal(waited.result.status, 'sync-required', 'not IN_PROGRESS, not a timeout');
  assert.equal(waited.result.code, 'SYNC_REQUIRED');
  assert.equal(waited.result.inProgress, false);
  assert.equal(waited.result.successful, false);
  assert.deepEqual(waited.result.syncRequired.paths, ['src/agent-workflow.ts']);
  // The fixture's compose names no Lane and readers never see the message: the CLI adds both
  // from the retained land command; the bare form runs inside the Lane checkout.
  assert.deepEqual(waited.result.next, { action: 'land', save: true });
  assert.equal(waited.result.command, `nforge agent '/work/root' land --save '{}'`);
  assert.match(waited.result.instruction, /^SYNC_REQUIRED: .*Stop waiting.*inside the Lane checkout/);
  // Observe guidance agrees: the advice and the queue say SYNC_REQUIRED, with no ETA.
  const observed = await page({ operationId: d1.operationId, nextVersion: 0 });
  assert.match(observed.wouldConflict.next, /^SYNC_REQUIRED: .*Do not keep waiting/);
  assert.equal(observed.queue.phase, 'needs-sync');
  assert.equal(observed.queue.eta, undefined);
  assert.equal(observed.queue.message, observed.wouldConflict.next);
  // The queue view (Lane side and owner side read the same rows) shows phase needs-sync.
  const view = JSON.parse(await f.call('syncQueue', queueView.read, { projectId: f.projectId }, 'owner'));
  const listed = view.entries.find(entry => entry.submissionId === d1.id);
  assert.equal(listed.phase, 'needs-sync');
  assert.deepEqual(listed.needsSync.paths, ['src/agent-workflow.ts']);
  assert.match(listed.needsSync.next, /^SYNC_REQUIRED/);
  assert.notEqual(view.entries.find(entry => entry.submissionId === ahead.id).phase, 'needs-sync');
  // land's receipt names the same recovery (with the Lane it was given), says so, and has no wait.
  const laneId = randomUUID();
  const land = normalizeHostedFinishResult(
    '/work/root',
    {},
    {
      phase: 'finish',
      replayParameters: { laneId, message: 'D1: tighten workflow docs' },
      ...waited.result.submissions[0],
      waitStatus: 'sync-required',
      inProgress: true,
    },
  );
  assert.equal(land.code, 'SYNC_REQUIRED');
  assert.equal(land.waitCommand, undefined);
  assert.equal(
    land.command,
    `nforge agent '/work/root' land --save '{"laneId":"${laneId}","message":"D1: tighten workflow docs"}'`,
  );
  assert.equal(landWaitContinuation('/work/root', { operationId: d1.operationId, result: land }), undefined);
  assert.deepEqual(landSummary({ result: land }), [
    'SYNC REQUIRED; not landed: main changed 1 file(s) this queued landing also changes (src/agent-workflow.ts)',
    `Continue recovery: ${land.command}`,
  ]);
});
