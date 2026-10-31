// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { landingFixture } from './hosted-landing-fixture.mjs';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/portable-hash.js';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { queuedConflict } from '../dist/hosted-agent-finish.js';

const wouldConflict = await import(moduleUrl('../convex/projectHostedLandingWouldConflict.ts'));
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
const mark = (f, paths, landedSubmissionId) =>
  f.run('wouldConflict', (ctx, input) => wouldConflict.markWouldConflict(ctx, input), {
    projectId: f.projectId,
    paths,
    landedSubmissionId,
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
  assert.match(marked.next, /Sync and land this Lane again/);
  assert.equal(rowOf(f, unrelated.id).wouldConflict, undefined, 'no shared path');
  assert.equal(rowOf(f, checking.id).wouldConflict, undefined, 'already checked against a pinned main');
  assert.equal(rowOf(f, landing.id).wouldConflict, undefined, 'the landing itself');
  const cost = f.counts.slice(before).find(c => c.name === 'wouldConflict');
  assert(
    cost.documents <= 20 + 3 * 3,
    `one bounded queue read plus three reads per Candidate: ${cost.documents}`,
  );
  assert.equal(cost.writes, 1);
  // The stale entry's receipt says so; others do not.
  const status = await f.status(stale.id);
  assert.deepEqual(status.wouldConflict, marked);
  assert.equal((await f.status(unrelated.id)).wouldConflict, undefined);
  // Marking twice changes nothing.
  assert.equal(await mark(f, ['convex/cost.ts'], landing.id), 0);
  assert.equal(rowOf(f, stale.id).wouldConflict, canonicalPayload(marked));
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
  assert(cost.ranges <= 1 + 3 * wouldConflict.WOULD_CONFLICT_READS, `ranges ${cost.ranges}`);
  assert(cost.documents <= wouldConflict.WOULD_CONFLICT_SCAN + 3 * wouldConflict.WOULD_CONFLICT_READS);
  assert.equal(cost.writes, marked);
});

test('a replay of the queued land names the in-place re-land; reads only when queued', async () => {
  const reads = [];
  const session = {
    root: '/work/lane',
    marker: () => ({ selection: { laneId: 'lane-1' } }),
    query: async (name, args) => {
      reads.push([name, args]);
      return { wouldConflict: { paths: ['convex/cost.ts'], next: 'Sync and land this Lane again' } };
    },
  };
  const replay = await queuedConflict(session, { id: 'sub-1', phase: 'queued' });
  assert.equal(replay.next, 'sync-and-land');
  assert.equal(replay.nextCommand, `nforge agent '/work/lane' land --save '{"laneId":"lane-1"}'`);
  assert.deepEqual(reads, [['projectHostedLanding:status', { submissionId: 'sub-1' }]]);
  assert.deepEqual(await queuedConflict(session, { id: 'sub-1', phase: 'checking' }), {});
  assert.equal(reads.length, 1, 'no read past the queue');
  const failing = { ...session, query: async () => Promise.reject(new Error('offline')) };
  assert.deepEqual(await queuedConflict(failing, { id: 'sub-1', phase: 'queued' }), {}, 'advisory only');
});
