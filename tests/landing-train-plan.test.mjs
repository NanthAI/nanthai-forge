// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './landing-batch-fixture.mjs';
import { planLandingTrain } from '../dist/landing-train-plan.js';
import { savedOverlapPlan } from '../dist/agent-overlap-plan.js';
import { CoordinationJournal } from '../dist/agent-coordination-journal.js';
import { waitObservation } from '../dist/agent-wait-observation.js';
import { agentWait } from '../dist/agent-wait.js';
import { batchEdit, selectBatch, composeBatch, enqueueLanding } from '../dist/landing-batch-store.js';
import { drainLandingBatches } from '../dist/landing-batch.js';
import { randomUUID } from 'node:crypto';

const base = '# Document\n\nShared paragraph.\nAnother paragraph.\n\nEnd.\n';
const text = index =>
  base.replace('Another paragraph.', `${`docs-${index} addition.\n`.repeat(index + 1)}Another paragraph.`);
const setup = async t => {
  const f = await fixture(t, { files: { 'shared.md': base } });
  const dispatch = f.agent.dispatch.bind(f.agent);
  // These tests assert completed background overlap analysis as well as train planning.
  const { agentResponseAdvisory } = await import('../dist/agent-response-advisory.js');
  const { parseAgentAction } = await import('../dist/agent-action-parse.js');
  const { resolveAgentDefaults } = await import('../dist/agent-defaults.js');
  f.agent.dispatch = async input => {
    const response = await dispatch(input);
    if (['start', 'checkpoint'].includes(input.action)) {
      const { command } = resolveAgentDefaults(
        f.store,
        parseAgentAction({ ...input, ...response.result.resolved }),
      );
      await agentResponseAdvisory(f.store, command, response, undefined, [], false, false);
    }
    return response;
  };
  return f;
};
const plan = f => planLandingTrain(f.store, f.store.load(), 'main');
const trainEvent = (f, laneId) =>
  waitObservation(f.store, 'lane', laneId).events.find(e => e.type === 'train');
const runs = f => f.store.load().runs.filter(run => !run.mainCheck && !f.soloRuns.has(run.id));

test('four overlapping docs submissions use the shared plan, sync before checks and batch independent code', async t => {
  const f = await setup(t),
    docs = [];
  for (let i = 0; i < 4; i++) docs.push(await f.candidate('shared.md', text(i)));
  const code = [await f.candidate('alpha.ts'), await f.candidate('beta.ts')];
  await f.checkCandidates([docs[0], ...code]);
  const initial = plan(f),
    data = f.store.load();
  const expected = savedOverlapPlan(f.store, data.lanes);
  assert.deepEqual(initial.plan.groups, expected.groups);
  assert.deepEqual(
    initial.pending.slice(0, 4).map(e => e.id),
    docs.map(d => d.command.operationId),
  );
  assert.deepEqual(
    initial.waits.map(w => w.entryId),
    docs.slice(1).map(d => d.command.operationId),
  );
  const revision = f.store.revision();
  const journalFiles = readdirSync(join(f.store.directory, 'coordination')).sort();
  const event = trainEvent(f, docs[0].lane.laneId);
  assert.deepEqual(event.groups, initial.plan.groups);
  assert.deepEqual(event.waits, initial.waits);
  assert.deepEqual(
    event.order,
    initial.ordered.map(e => e.id),
  );
  assert.equal(f.store.revision(), revision);
  assert.deepEqual(readdirSync(join(f.store.directory, 'coordination')).sort(), journalFiles);
  // Dirty work is never rewritten to sync a submitted Candidate.
  writeFileSync(join(docs[3].lane.path, 'shared.md'), 'unsaved work\n');
  const dispatch = f.work.dispatch.bind(f.work);
  f.work.dispatch = async (command, ...args) => {
    if (command.action === 'run-check') {
      const view = f.store.select('views', command.viewId);
      const pin = view.inputs.find(pin => docs.some(d => d.lane.laneId === pin.laneId));
      const index = docs.findIndex(d => d.lane.laneId === pin?.laneId);
      if (index > 0) {
        const predecessor = f.store.select('landingEntries', docs[index - 1].command.operationId);
        assert.equal(predecessor.status, 'accepted');
        const receipt = f.store.select('channelMoves', predecessor.acceptanceId);
        assert.equal(view.composedMain, receipt.head);
      }
    }
    return dispatch(command, ...args);
  };
  await drainLandingBatches(f.work, 'main');
  const final = f.store.load();
  assert.ok(final.landingEntries.every(e => e.status === 'accepted'));
  assert.equal(final.landingBatches.length, 4);
  assert.equal(runs(f).length, 4);
  const entries = ids => ids.map(id => f.store.select('landingEntries', id));
  assert.equal(new Set(entries(code.map(c => c.command.operationId)).map(e => e.batchId)).size, 1);
  assert.equal(new Set(entries(docs.map(c => c.command.operationId)).map(e => e.batchId)).size, 4);
  for (let i = 0; i < 4; i++) assert.ok(f.content('shared.md').includes(`docs-${i} addition.`));
  assert.equal(
    (await import('node:fs')).readFileSync(join(docs[3].lane.path, 'shared.md'), 'utf8'),
    'unsaved work\n',
  );
  assert.equal(trainEvent(f, docs[0].lane.laneId).status, 'idle');
});

test('one genuine rewrite remains a named conflict without an acknowledgement gate', async t => {
  const f = await setup(t),
    docs = [];
  for (let i = 0; i < 4; i++)
    docs.push(
      await f.candidate('shared.md', i < 2 ? text(i) : base.replace('Shared paragraph.', `rewrite ${i}.`)),
    );
  const ordered = plan(f).pending;
  const rewrites = ordered.filter(e => docs.slice(2).some(d => d.command.operationId === e.id));
  const earlier = docs.find(d => d.command.operationId === rewrites[0].id);
  await drainLandingBatches(f.work, 'main');
  const entries = f.store.load().landingEntries;
  assert.equal(entries.filter(e => e.status === 'accepted').length, 3);
  const conflict = entries.find(e => e.status === 'conflict');
  assert.ok(conflict);
  assert.match(f.store.select('views', conflict.conflictViewId).details, new RegExp(earlier.lane.laneId));
  assert.equal(runs(f).length, 3, 'conflicting source never reaches a check');
  assert.ok(new CoordinationJournal(f.store).overlaps().length);
  assert.ok(readdirSync(join(f.store.directory, 'coordination')).every(name => !name.startsWith('ack-')));
});

test('new saves supersede live predictions and notice applicability without changing the original submitted pins', async t => {
  const f = await setup(t);
  const a = await f.candidate('shared.md', text(0)),
    b = await f.candidate('shared.md', text(1));
  const original = plan(f);
  const noticeIds = new CoordinationJournal(f.store).overlaps().map(n => n.noticeId);
  assert.ok(noticeIds.length);
  writeFileSync(join(b.lane.path, 'shared.md'), base);
  writeFileSync(join(b.lane.path, 'new-code.ts'), 'export const newer = true;\n');
  const newer = (
    await f.agent.dispatch({
      action: 'checkpoint',
      laneId: b.lane.laneId,
      message: 'Save independent replacement',
    })
  ).result;
  assert.equal(savedOverlapPlan(f.store, f.store.load().lanes).groups.length, 0);
  assert.deepEqual(plan(f).plan.groups, original.plan.groups);
  const events = waitObservation(f.store, 'operation', b.command.operationId).events;
  const alerts = events.filter(e => e.type === 'notice' && noticeIds.includes(e.id));
  assert.equal(alerts.length, noticeIds.length);
  assert.ok(alerts.every(e => e.historical));
  const event = events.find(e => e.type === 'train');
  assert.equal(
    event.entries.find(e => e.entryId === b.command.operationId).inputs[0].head,
    b.checkpoint.head,
  );
  const first = await batchEdit(f.work, 'select', data => selectBatch(f.work, data, 'main'));
  assert.deepEqual(first.entryIds, [a.command.operationId]);
  await composeBatch(f.work, first);
  const revision = f.store.revision();
  const next = await batchEdit(f.work, 'select', data =>
    selectBatch(f.work, data, 'main', new Set([first.id])),
  );
  assert.equal(next, undefined, 'new live disjoint prediction cannot overtake a pinned overlap');
  assert.equal(f.store.revision(), revision);
  await drainLandingBatches(f.work, 'main');
  assert.equal(f.store.select('lanes', b.lane.laneId).head, newer.head);
  assert.ok(f.content('shared.md').includes('docs-0 addition.'));
  assert.ok(!f.content('shared.md').includes('docs-1 addition.'));
  const superseded = f.store.select('landingEntries', b.command.operationId);
  assert.equal(superseded.status, 'interrupted');
  assert.ok(superseded.reason.includes(newer.head));
  assert.equal(f.content('new-code.ts'), undefined);
});

test('a replacement submission derives a fresh disjoint plan and wait cursors deduplicate notices and train snapshots', async t => {
  const f = await setup(t);
  const a = await f.candidate('shared.md', text(0)),
    b = await f.candidate('shared.md', text(1), false);
  writeFileSync(join(b.lane.path, 'shared.md'), base);
  writeFileSync(join(b.lane.path, 'replacement.ts'), 'export const fresh = true;\n');
  const saved = (
    await f.agent.dispatch({ action: 'checkpoint', laneId: b.lane.laneId, message: 'Replace unsent source' })
  ).result;
  const composed = (
    await f.agent.dispatch({
      action: 'compose',
      operationId: randomUUID(),
      intentId: b.lane.intentId,
      inputs: [{ laneId: b.lane.laneId, head: saved.head }],
      dependencies: [],
    })
  ).result;
  const replacement = await enqueueLanding(
    f.work,
    { ...b.command, operationId: randomUUID(), expectedHead: saved.head },
    f.store.select('views', composed.viewId),
  );
  assert.equal(plan(f).plan.groups.length, 0);
  const events = [];
  const first = await agentWait(f.store, { laneIds: [a.lane.laneId], timeoutSeconds: 0 }, e =>
    events.push(e),
  );
  assert.ok(events.some(e => e.type === 'notice'));
  assert.ok(events.some(e => e.type === 'train'));
  const resumed = [];
  await agentWait(f.store, { laneIds: [a.lane.laneId], timeoutSeconds: 0, cursor: first.cursor }, e =>
    resumed.push(e),
  );
  assert.deepEqual(
    resumed.map(e => e.type),
    ['summary'],
  );
  await f.checkCandidates();
  const batch = await batchEdit(f.work, 'select', data => selectBatch(f.work, data, 'main'));
  assert.deepEqual(batch.entryIds, [a.command.operationId, replacement.id]);
  await drainLandingBatches(f.work, 'main');
  assert.equal(runs(f).length, 1);
});
