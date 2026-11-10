// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup, actions, work } from './hosted-planning-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { trackReadSets } from './hosted-read-set.mjs';
import { speedBudgets } from '../dist/speed-budgets.js';
import { judgeCosts } from '../dist/cost-budgets.js';
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
  await indexActions.ensure._handler(s.ctx, { rebuild: true, projectId: s.projectId });
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
    // 4 -> 3 (435c7c2f): the project state every tab holds no longer reads the Work head row; 3 -> 2
    // (flip 5 S4): neither does the workspace query.
    2,
    'Intent list and notes page change; the workspace, project state and unrelated pages stay subscribed',
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

// Flip 5 acceptance meter: Work query re-runs per planning write for one open tab (Issue 0695ab24). Three
// tabs re-run three times this. Before S4 every write re-ran 3 (the workspace query read the project head
// row on every write); with the workspace off the head it is 2 (6 for three tabs): the Intent list, since an
// Issue is also an Intent row, and the one page holding the written item.
test('flip 5 re-run meter: Work queries one tab re-runs per planning write', async t => {
  const s = await setup(t);
  const initial = await s.read(),
    intentId = randomUUID();
  await actions.command._handler(s.ctx, {
    projectId: s.projectId,
    operationId: intentId,
    revision: initial.data.revision,
    command: JSON.stringify({
      action: 'intent',
      outcome: 'Meter',
      constraints: '',
      base: initial.sourceHead,
    }),
  });
  const issues = [];
  for (let i = 0; i < 5; i++) {
    const item = s.item({ title: `Issue ${i}` });
    await s.send(item);
    issues.push(item);
  }
  await indexActions.ensure._handler(s.ctx, { rebuild: true, projectId: s.projectId });
  const pages = ['intents', 'notes', 'planningItems', 'planningComments', 'lanes', 'views', 'runs'];
  const names = ['state', 'workspace', ...pages, 'unrelated Issue detail'];
  const subscriptions = [
    () => work.state._handler(s.ctx, { projectId: s.projectId }),
    () => index.workspace._handler(s.ctx, { projectId: s.projectId }),
    ...pages.map(
      collection => () =>
        index.records._handler(s.ctx, {
          projectId: s.projectId,
          collection,
          paginationOpts: { cursor: null, numItems: 100 },
        }),
    ),
    () =>
      index.detail._handler(s.ctx, {
        projectId: s.projectId,
        collection: 'planningItems',
        id: issues[0].itemId,
      }),
  ];
  const tracking = trackReadSets(s.ctx, s.tables);
  const meter = async status => {
    const dependencies = [];
    for (const subscribe of subscriptions) dependencies.push(await tracking.subscribe(subscribe));
    const rerun = async write => {
      tracking.reset();
      await write();
      return names.filter((_, i) => tracking.invalidated([dependencies[i]]) === 1);
    };
    return {
      'new Issue': await rerun(() => s.send(s.item({ title: 'New' }))),
      'Issue status': await rerun(() => s.send({ ...issues[4], operationId: randomUUID(), ...status })),
      'Issue comment': await rerun(() =>
        s.send({
          action: 'comment-planning-item',
          operationId: randomUUID(),
          itemId: issues[4].itemId,
          text: 'c',
          authorLabel: 'Owner',
        }),
      ),
      'Intent note': await rerun(() => s.send({ action: 'note', intentId, text: 'n', kind: 'comment' })),
    };
  };
  const measured = await meter({ expectedVersion: 1, status: 'closed' });
  const expected = {
    'new Issue': ['intents', 'planningItems'],
    'Issue status': ['intents', 'planningItems'],
    'Issue comment': ['intents', 'planningComments'],
    'Intent note': ['intents', 'notes'],
  };
  assert.deepEqual(measured, expected);
  // S4: with the store reader on, the Issue list and detail read record heads; the dual write adds no
  // re-run (an Issue head, a comment head and an Intent version sit in separate kinds).
  s.tables.hostedProjects.get(s.projectId).workStore = 'records';
  assert.deepEqual(await meter({ expectedVersion: 2, status: 'open' }), expected);
  s.tables.hostedProjects.get(s.projectId).workStoreWriters = ['note', 'intent', 'intent-status', 'planning'];
  s.tables.hostedProjects.get(s.projectId).workStoreCutoverRevision = (await s.read()).data.revision;
  assert.deepEqual(
    await meter({ expectedVersion: 3, status: 'closed' }),
    expected,
    'freezing journal appends retains six reruns across three tabs',
  );
  console.log(
    JSON.stringify({ perTab: Object.fromEntries(Object.entries(measured).map(([k, v]) => [k, v.length])) }),
  );
  // Ledger entry planning-reruns (src/speed-budgets.json): the worst write with three tabs open.
  const planningReruns = 3 * Math.max(...Object.values(measured).map(v => v.length));
  assert.deepEqual(
    judgeCosts(speedBudgets.costs, speedBudgets.costGuard, 'planning-fixture', { planningReruns })
      .filter(v => v.metric === 'planningReruns' && v.status !== 'pass')
      .map(v => v.message),
    [],
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

// Flip 5 S5 (Issue 0695ab24): 57 of 60 refused planning writes were unrelated writes moving the project-wide
// revision. A put now runs in the revision-free mutation: its only check is its own item version.
test('planning puts in the revision-free mutation: unrelated writes never refuse, a stale item names ITEM_CHANGED', async t => {
  const s = await setup(t);
  const send = command =>
    mutations.command._handler(s.ctx, {
      projectId: s.projectId,
      operationId: command.operationId,
      command: JSON.stringify(command),
    });
  const issue = s.item({ title: 'Put without revision' }),
    other = s.item({ title: 'Unrelated' });
  await send(issue);
  await send(other);
  await send({ ...other, operationId: randomUUID(), expectedVersion: 1, status: 'closed' });
  const move = { ...issue, operationId: randomUUID(), expectedVersion: 1, status: 'in-progress' };
  const first = await send(move);
  assert.deepEqual(await send(move), first, 'a replay returns the original receipt, not a second version');
  const stored = (await s.read()).data.planningItems.filter(item => item.id === issue.itemId);
  assert.deepEqual(
    stored.map(item => [item.version, item.status]),
    [
      [1, 'open'],
      [2, 'in-progress'],
    ],
  );
  await assert.rejects(
    send({ ...issue, operationId: randomUUID(), expectedVersion: 1, status: 'closed' }),
    e =>
      e.data.code === 'ITEM_CHANGED' &&
      JSON.stringify(e.data.recovery) ===
        JSON.stringify({ kind: 'issue', id: issue.itemId, expectedVersion: 1, currentVersion: 2 }),
  );
  s.tables.projectContributors.set('contributor', {
    _id: 'contributor',
    projectId: s.projectId,
    contributor: 'member',
  });
  s.caller('member');
  await assert.rejects(
    send({ ...issue, operationId: randomUUID(), expectedVersion: 2, status: 'closed' }),
    e => e.data.code === 'PROJECT_UNAVAILABLE',
    'planning stays owner-only',
  );
});

// Part 9: completing cutover removes disposable source/target fingerprints from ordinary writes.
// The before fixture leaves an unrelated writer in migration, so the measured command already owns
// primary provenance on both sides; the difference is its migration telemetry alone.
test('primary Work writes retire migration I/O without changing item versions or tab reads', async t => {
  const { meterWorkIO } = await import('./hosted-read-set.mjs');
  const store = await import(moduleUrl('../convex/projectWorkStore.ts'));
  const { writeHostedRecord } = await import(moduleUrl('../convex/projectHostedRecords.ts'));
  const writers = ['note', 'intent', 'intent-status', 'planning'];
  const measure = async primary => {
    const s = await setup(t);
    const project = s.tables.hostedProjects.get(s.projectId);
    project.sourceAuthority = { mode: 'server', epoch: 1 };
    await store.setMode._handler(s.ctx, { projectId: s.projectId, mode: 'records', writers });
    const base = (await s.read()).sourceHead;
    const intentId = randomUUID(),
      issue = s.item();
    const send = (command, operationId = command.operationId ?? randomUUID()) =>
      mutations.command._handler(s.ctx, {
        projectId: s.projectId,
        operationId,
        command: JSON.stringify(command),
      });
    await send({ action: 'intent', outcome: 'I/O fixture', constraints: '', base }, intentId);
    await send(issue);
    const io = meterWorkIO(s.ctx, s.tables);
    const costs = {};
    for (const [name, command] of [
      ['note', { action: 'note', intentId, text: 'A retained note', kind: 'comment' }],
      ['intent', { action: 'intent', outcome: 'Next fixture', constraints: '', base }],
      ['status', { action: 'intent-status', intentId, status: 'completed' }],
      ['put', { ...issue, operationId: randomUUID(), expectedVersion: 1, status: 'closed' }],
      [
        'comment',
        {
          action: 'comment-planning-item',
          operationId: randomUUID(),
          itemId: issue.itemId,
          text: 'A retained comment',
          authorLabel: '',
        },
      ],
    ]) {
      // Every measured command is primary, including in the migration-maintenance baseline.
      project.workStoreWriters = primary
        ? writers
        : writers.filter(writer => writer !== (name === 'intent' ? 'note' : 'intent'));
      costs[name] = await io.cost(() => send(command));
    }
    project.workStoreWriters = primary ? writers : writers.filter(writer => writer !== 'note');
    costs.hostedIntent = await io.cost(() =>
      writeHostedRecord(s.ctx, {
        projectId: s.projectId,
        actor: 'owner',
        authorityEpoch: 1,
        expectedVersion: null,
        record: {
          kind: 'intent',
          id: randomUUID(),
          version: 0,
          at: '2026-01-01T00:00:00.000Z',
          creatorAccountId: 'owner',
          outcome: 'Pinned fixture',
          constraints: '',
          status: 'active',
          assigneeAccountIds: [],
          base: { head: base, receiptId: 'fixture-receipt' },
        },
      }),
    );
    io.restore();
    return costs;
  };
  const before = await measure(false),
    after = await measure(true);
  for (const name of Object.keys(after)) {
    assert.ok(before[name].migrationWrites > 0, `${name}: baseline exercises migration maintenance`);
    assert.equal(after[name].migrationWrites, 0, `${name}: primary writes no migration metadata`);
    for (const dimension of ['readDocuments', 'readBytes', 'writeDocuments', 'writeBytes'])
      assert.ok(
        after[name][dimension] < before[name][dimension],
        JSON.stringify({ name, dimension, before: before[name], after: after[name] }),
      );
  }
  const measured = {
    planningPrimaryReadBytes: Math.max(...Object.values(after).map(cost => cost.readBytes)),
    planningPrimaryWriteBytes: Math.max(...Object.values(after).map(cost => cost.writeBytes)),
    planningMigrationWrites: Math.max(...Object.values(after).map(cost => cost.migrationWrites)),
  };
  assert.deepEqual(
    judgeCosts(speedBudgets.costs, speedBudgets.costGuard, 'planning-fixture', measured)
      .filter(v => v.metric in measured && v.status !== 'pass')
      .map(v => v.message),
    [],
  );
  console.log(JSON.stringify({ primaryWorkIO: { before, after } }));
});
