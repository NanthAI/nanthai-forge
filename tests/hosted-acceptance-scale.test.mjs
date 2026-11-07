// SPDX-License-Identifier: Apache-2.0
import { observerProjectionBudget } from './observer-projection-budget.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acceptanceFixture, maxima } from './hosted-acceptance-fixture.mjs';
import { policyPreset } from '../dist/autonomy-policy.js';

test('205 included Lanes and 10,050 retained receipts keep final CAS constant; completion resumes in bounded windows', async () => {
  const f = await acceptanceFixture();
  f.patch('hostedProjects', f.projectId, { autonomyPolicy: policyPreset('trusted') });
  const lanes = [];
  for (let i = 0; i < 205; i++) lanes.push(await f.lane());
  const item = await f.makeCandidate(lanes);
  const { state } = await f.ready(item);
  const plan = [...f.tables.projectHostedAcceptancePlans.values()][0];
  assert.equal(plan.inputPages, 3);
  assert.equal(plan.lanes, 205);
  const count = f.tables.projectHostedAcceptancePages.size;
  await f.stageAcceptance(state, item.pages);
  assert.equal(f.tables.projectHostedAcceptancePages.size, count, 'lost page reply reconciles');
  for (let i = 0; i < 10050; i++)
    f.insert('projectHostedAcceptances', {
      projectId: f.projectId,
      receiptId: randomUUID(),
      submissionId: randomUUID(),
      attemptId: randomUUID(),
      sequence: i,
      value: '{}',
    });
  const started = performance.now(),
    rssBefore = process.memoryUsage().rss;
  const { receipt } = await f.accept(state);
  assert.equal(receipt.completion.lanes, 205);
  const final = f.counts.filter(c => c.name === 'acceptanceAccept').at(-1);
  const firstCompletion = f.pendingTasks().find(task => task.name === 'projectHostedAcceptance:complete')
    .args[0];
  assert(
    Buffer.byteLength(JSON.stringify(firstCompletion.precompose)) < 1024,
    'publication retains a small trigger, not source path lists',
  );
  const source = observerProjectionBudget(final);
  // Writes 15 -> 16 (13c63abe): the completion tick's stall guard is scheduled with it and both ids
  // are retained on the plan, so a lost tick is replayed. Calls are unchanged; the tick cancels the guard.
  // Ranges/documents 40 -> 41, writes 16 -> 17 (45f49fb7): the landing reads and rewrites the project's
  // landing-speed row (regression ladder rung 1, under 16 KB); still constant in history.
  assert(source.ranges <= 41 && source.documents <= 41 && source.writes <= 17, JSON.stringify(final));
  assert(source.readBytes < 40 * 1024 && source.writeBytes < 16 * 1024);
  assert(!final.touched.includes('projectHostedAcceptancePages'));
  // 41 = 39 plus the one submission-order read before claiming main (incident e4aee4fe) and the
  // landing-speed row (45f49fb7); still constant.
  assert(!final.touched.includes('projectHostedRecordHeads') || source.documents <= 41);
  let ticks = 0;
  while (f.pendingTasks().some(t => t.name === 'projectHostedAcceptance:complete')) {
    assert(++ticks < 30, 'only outstanding finite completion work schedules itself');
    const task = f.pendingTasks().find(t => t.name === 'projectHostedAcceptance:complete');
    f.patch('_scheduled_functions', task._id, { state: { kind: 'inProgress' } });
    await f.materialize(task.args[0].receiptId, task.args[0].precompose);
    f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
  }
  assert.equal(ticks, 11);
  for (const lane of lanes) assert.equal((await f.readLane(lane.laneId)).state, 'completed');
  assert.equal(f.pendingTasks().length, 0);
  const completedPlan = [...f.tables.projectHostedAcceptancePlans.values()][0];
  assert.equal(completedPlan.appliedPage, 3);
  const scheduled = f.metrics.scheduled;
  await f.materialize(receipt.id, firstCompletion.precompose);
  assert.equal(f.metrics.scheduled, scheduled, 'idle completed plans schedule nothing');
  console.log(
    'H14 scale evidence',
    JSON.stringify({
      lanes: lanes.length,
      retainedReceipts: 10050,
      inputPages: 3,
      ticks,
      final: Object.fromEntries(
        ['ranges', 'documents', 'readBytes', 'writes', 'writeBytes'].map(k => [k, final[k]]),
      ),
      elapsedMs: performance.now() - started,
      rssBefore,
      rssAfter: process.memoryUsage().rss,
      maxRss: process.resourceUsage().maxRSS * 1024,
      maxima,
    }),
  );
});
