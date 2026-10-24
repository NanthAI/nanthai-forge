// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup, actions, work } from './hosted-planning-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { trackReadSets } from './hosted-read-set.mjs';
const mutations = await import(moduleUrl('../convex/projectWorkCommand.ts'));
const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const indexActions = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));

test('hosted note contention and reactive read-set measurement', async t => {
  const s = await setup(t);
  const initial = await s.read(),
    intentId = randomUUID();
  await actions.command._handler(s.ctx, {
    projectId: s.projectId,
    operationId: intentId,
    revision: initial.data.revision,
    command: JSON.stringify({
      action: 'intent',
      outcome: 'Contention fixture',
      constraints: '',
      base: initial.sourceHead,
    }),
  });
  await indexActions.ensure._handler(s.ctx, { projectId: s.projectId });
  const subscriptions = [
    () => work.state._handler(s.ctx, { projectId: s.projectId }),
    () => index.workspace._handler(s.ctx, { projectId: s.projectId }),
    ...['intents', 'notes', 'planningItems', 'planningComments', 'lanes', 'views', 'runs'].map(
      collection => () =>
        index.records._handler(s.ctx, {
          projectId: s.projectId,
          collection,
          paginationOpts: { cursor: null, numItems: 100 },
        }),
    ),
  ];
  const tracking = trackReadSets(s.ctx, s.tables);
  const dependencies = [];
  for (const subscribe of subscriptions) dependencies.push(await tracking.subscribe(subscribe));
  const revision = (await s.read()).data.revision;
  const note = () => ({
    projectId: s.projectId,
    operationId: randomUUID(),
    revision,
    command: JSON.stringify({ action: 'note', intentId, text: 'Concurrent note', kind: 'comment' }),
  });
  // This in-memory fixture has no OCC. Serialize transactions to model Convex's
  // successful retry/commit boundary; this measures client-visible WORK_STALE, not OCC retries.
  let tail = Promise.resolve();
  const send = input => {
    const { revision: _, ...args } = input;
    const result = tail.then(() => mutations.command._handler(s.ctx, args));
    tail = result.catch(() => {});
    return result;
  };
  tracking.reset();
  const firstInput = note();
  const first = await send(firstInput);
  const invalidated = tracking.invalidated(dependencies);
  assert.equal(
    invalidated,
    4,
    'Work state, workspace, Intent list and notes page change; unrelated pages stay subscribed',
  );
  assert.deepEqual(await send({ ...firstInput, revision: 0 }), first, 'retry does not depend on revision');
  await assert.rejects(
    send({
      ...firstInput,
      command: JSON.stringify({ action: 'note', intentId, text: 'Changed', kind: 'comment' }),
    }),
    e => e.data.code === 'WORK_OPERATION_CHANGED',
  );
  let conflicts = 0;
  for (let i = 0; i < 10; i++) {
    const current = (await s.read()).data.revision;
    const pair = await Promise.allSettled([
      send({ ...note(), revision: current }),
      send({ ...note(), revision: current }),
    ]);
    for (const result of pair)
      if (result.status === 'rejected') {
        assert.equal(result.reason.data.code, 'WORK_STALE');
        conflicts++;
      }
  }
  assert.equal(conflicts, 0);
  const replay = await s.read();
  assert.equal(
    replay.data.intents.find(i => i.id === intentId).notes.length,
    21,
    'both notes in every concurrent pair are retained',
  );
  assert.equal(replay.data.revision, first.revision + 20);
  s.caller('stranger');
  await assert.rejects(send(note()), e => e.data.code === 'PROJECT_UNAVAILABLE');
  s.caller('owner');
  const status = {
    ...note(),
    command: JSON.stringify({ action: 'intent-status', intentId, status: 'completed' }),
  };
  await send(status);
  assert.equal((await s.read()).data.intents.find(i => i.id === intentId).status, 'completed');
  console.log(
    JSON.stringify({
      subscriptions: subscriptions.length,
      invalidated,
      concurrentWrites: 20,
      conflicts,
      firstRevision: first.revision,
    }),
  );
});

test('revision-free planning comments and contributor notes retain authorization and original receipts', async t => {
  const s = await setup(t);
  const issue = s.item();
  await s.send(issue);
  const send = (command, operationId = command.operationId ?? randomUUID()) =>
    mutations.command._handler(s.ctx, {
      projectId: s.projectId,
      operationId,
      command: JSON.stringify(command),
    });
  const comment = () => ({
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId: issue.itemId,
    text: 'Planning discussion',
    authorLabel: 'Owner',
  });
  const one = comment(),
    two = comment();
  await send(one);
  await send(two);
  assert.equal((await s.read()).data.planningComments.length, 2);
  assert.deepEqual(await send(one), await send(one));
  s.tables.projectContributors.set('contributor', {
    _id: 'contributor',
    projectId: s.projectId,
    contributor: 'member',
  });
  s.caller('member');
  await assert.rejects(send(comment()), e => e.data.code === 'PROJECT_UNAVAILABLE');
  const current = await s.read(),
    intentId = randomUUID();
  await send(
    { action: 'intent', outcome: 'Member work', constraints: '', base: current.sourceHead },
    intentId,
  );
  const note = { action: 'note', intentId, text: 'Member note', kind: 'comment' },
    operationId = randomUUID();
  await send(note, operationId);
  s.tables.projectContributors.delete('contributor');
  await assert.rejects(send(note, operationId), e => e.data.code === 'PROJECT_UNAVAILABLE');
  s.caller(null);
  await assert.rejects(send(note), e => e.data.code === 'PROJECT_UNAVAILABLE');
});
