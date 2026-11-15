// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceFixture, api } from './hosted-acceptance-fixture.mjs';

test('accepted manual deadline transfers to guarded completion and a lost tick preserves cleanup ownership', async () => {
  const f = await acceptanceFixture();
  const item = await f.makeCandidate([await f.lane()]);
  const { state } = await f.ready(item);
  const ticket = [...f.tables.projectHostedLandingRequests.values()].find(
    row => row.submissionId === state.id,
  );
  const alarm = ticket.alarm.taskId;
  const { receipt } = await f.accept(state);
  let plan = [...f.tables.projectHostedAcceptancePlans.values()].find(row => row.receiptId === receipt.id);
  assert.equal(f.tables.projectHostedLandingRequests.get(ticket._id).alarm, null);
  assert.equal(plan.completion.alarm, alarm);
  assert.equal(
    f.tables._scheduled_functions.get(alarm).state.kind,
    'pending',
    'main CAS transfers cleanup without scheduler IO',
  );
  f.patch('_scheduled_functions', plan.completion.tick, { state: { kind: 'failed' } });
  f.patch('_scheduled_functions', plan.completion.guard, { state: { kind: 'inProgress' } });
  await f.transaction('acceptanceGuard', api.guard, { projectId: f.projectId, receiptId: receipt.id });
  plan = f.tables.projectHostedAcceptancePlans.get(plan._id);
  assert.equal(plan.completion.alarm, alarm, 'guard replay retains the pending deadline');
  await f.materialize(receipt.id);
  assert.equal(f.tables._scheduled_functions.get(alarm).state.kind, 'canceled');
  assert.equal(f.tables.projectHostedAcceptancePlans.get(plan._id).completion, undefined);
  const scheduled = f.metrics.scheduled;
  await f.materialize(receipt.id);
  assert.equal(f.metrics.scheduled, scheduled, 'completed replay creates no cleanup work');
  assert.equal(f.currentMain().head, receipt.candidate.head);
});
