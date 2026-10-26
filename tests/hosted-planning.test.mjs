// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { digest } from '../dist/hash.js';
import { setup, actions, work } from './hosted-planning-fixture.mjs';
import { readHosted } from './hosted-read.mjs';
const denied = error => error.data?.code === 'PROJECT_UNAVAILABLE';

test('whole-project hosted planning works without Intents, preserves versions/labels and reconciles a lost original reply', async t => {
  for (const native of [true, false]) {
    const s = await setup(t, native),
      before = await s.read();
    assert.equal(before.data.intents.length, 0);
    assert.equal(before.capabilities.planning, true);
    const initiative = s.item({ kind: 'initiative', title: 'Ship a useful project' });
    await s.send(initiative);
    const issue = s.item({ title: 'First Issue', initiativeId: initiative.itemId }),
      revision = (await s.read()).data.revision;
    const append = s.ctx.runMutation;
    let dropped = false;
    s.ctx.runMutation = async (ref, args) => {
      const result = await append(ref, args);
      if (!dropped && getFunctionName(ref) === 'projectWork:append') {
        dropped = true;
        throw Error('Lost committed reply');
      }
      return result;
    };
    await assert.rejects(s.send(issue, revision), error => error.data.code === 'HOSTED_REQUEST_FAILED');
    s.ctx.runMutation = append;
    const original = await s.send(issue, revision);
    assert.equal(original.operationId, issue.operationId);
    assert.equal(s.tables.projectWorkEvents.size, 2);
    await assert.rejects(
      s.send({ ...issue, title: 'Changed original request' }, revision),
      error => error.data.code === 'WORK_OPERATION_CHANGED',
    );
    await assert.rejects(
      actions.command._handler(s.ctx, {
        projectId: s.projectId,
        operationId: randomUUID(),
        revision,
        command: JSON.stringify(issue),
      }),
      error => error.data.code === 'BAD_ARGUMENT',
    );
    const close = s.item({
      ...issue,
      operationId: randomUUID(),
      expectedVersion: 1,
      status: 'closed',
      body: 'Original literal details\n<script>no execution</script>',
    });
    await s.send(close);
    await s.send({
      action: 'comment-planning-item',
      operationId: randomUUID(),
      itemId: issue.itemId,
      authorLabel: 'Supplied alias',
      text: 'Discuss even after closing.',
    });
    await s.send(
      s.item({
        ...close,
        operationId: randomUUID(),
        expectedVersion: 2,
        status: 'open',
        body: 'Reopened details',
      }),
    );
    const after = await s.read(),
      versions = after.data.planningItems.filter(item => item.id === issue.itemId);
    assert.deepEqual(
      versions.map(item => item.status),
      ['open', 'closed', 'open'],
    );
    assert.deepEqual(
      versions.map(item => item.version),
      [1, 2, 3],
    );
    assert.equal(after.data.planningComments[0].authorLabel, 'Supplied alias');
    assert.equal(after.data.planningComments[0].provenance, 'user-declared-local');
    assert.equal(after.events.find(event => event.id === after.data.planningComments[0].id).actor, 'owner');
    assert.equal(after.data.intents.length, 0);
    assert.equal(after.sourceHead, before.sourceHead);
    for (const key of ['lanes', 'views', 'runs', 'channelMoves', 'hostedChannelMoves'])
      assert.deepEqual(after.data[key], before.data[key]);
    const exported = JSON.parse(await actions.exportPlanning._handler(s.ctx, { projectId: s.projectId })),
      manifest = JSON.parse(exported.json);
    assert.equal(exported.sha256, digest(exported.json));
    assert.equal(manifest.kind, 'forge-hosted-planning');
    assert.deepEqual(manifest.items, after.data.planningItems);
    assert.deepEqual(manifest.comments, after.data.planningComments);
    assert.equal(manifest.linkedIntents.length, 0);
    assert.equal(manifest.events.length, 5);
    assert.match(manifest.coverage, /not offline authenticated authorship/);
    assert.deepEqual(await s.read(), after, 'Export is read-only.');
  }
});

test('planning rejects stale versions, invalid links/kind changes and concurrent writes without losing original records', async t => {
  const s = await setup(t),
    first = s.item();
  await s.send(first);
  const current = await s.read(),
    count = s.tables.projectWorkEvents.size;
  const invalid = [
    s.item({ intentIds: [randomUUID()] }),
    s.item({ initiativeId: randomUUID() }),
    s.item({ initiativeId: first.itemId }),
    s.item({ itemId: first.itemId, expectedVersion: 1, kind: 'initiative' }),
    s.item({ itemId: first.itemId, expectedVersion: 0 }),
  ];
  for (const command of invalid)
    await assert.rejects(s.send(command), error =>
      ['NOT_FOUND', 'BAD_ARGUMENT', 'PLANNING_CHANGED'].includes(error.data.code),
    );
  assert.equal(s.tables.projectWorkEvents.size, count);
  await assert.rejects(
    s.send(s.item(), current.data.revision - 1),
    error => error.data.code === 'WORK_STALE',
  );
  const planned = s.item({ itemId: first.itemId, expectedVersion: 1, title: 'Concurrent edit' }),
    append = s.ctx.runMutation;
  let raced = false;
  s.ctx.runMutation = async (ref, args) => {
    if (!raced && getFunctionName(ref) === 'projectWork:append' && args.operationId === planned.operationId) {
      raced = true;
      await s.send(
        s.item({ itemId: first.itemId, expectedVersion: 1, title: 'Other retained version' }),
        current.data.revision,
      );
    }
    return append(ref, args);
  };
  await assert.rejects(s.send(planned, current.data.revision), error => error.data.code === 'WORK_STALE');
  s.ctx.runMutation = append;
  await assert.rejects(s.send(planned), error => error.data.code === 'PLANNING_CHANGED');
  assert.deepEqual(
    (await s.read()).data.planningItems.map(item => item.title),
    ['Synthetic issue', 'Other retained version'],
  );
});

test('current owner alone writes/exports project planning; existing contributor projection/capability and scoped-reader denials remain intact', async t => {
  const s = await setup(t),
    command = s.item(),
    beforeReads = s.reads();
  for (const actor of [undefined, 'foreign', 'scoped-reader']) {
    s.caller(actor);
    for (const call of [
      () => s.send(command, s.preview.revision),
      () => actions.exportPlanning._handler(s.ctx, { projectId: s.projectId }),
      () => readHosted(s.ctx, { projectId: s.projectId }),
    ])
      await assert.rejects(call(), denied);
  }
  assert.equal(s.reads(), beforeReads, 'Nonmembers are denied before private source storage.');
  s.tables.projectContributors.set('grant', {
    _id: 'grant',
    projectId: s.projectId,
    contributor: 'member',
    at: new Date().toISOString(),
  });
  s.caller('member');
  const member = await s.read();
  assert.equal(member.capabilities.planning, false);
  assert.equal(member.capabilities.owner, false);
  const reads = s.reads();
  await assert.rejects(s.send(command, member.data.revision), denied);
  await assert.rejects(actions.exportPlanning._handler(s.ctx, { projectId: s.projectId }), denied);
  await assert.rejects(
    work.append._handler(s.ctx, {
      projectId: s.projectId,
      owner: 'member',
      operationId: command.operationId,
      previousRevision: member.data.revision,
      command: JSON.stringify(command),
      request: 'a'.repeat(64),
    }),
    denied,
  );
  assert.equal(s.reads(), reads);
  assert.equal(s.tables.projectWorkEvents.size, 0);
  s.caller('owner');
  const append = s.ctx.runMutation;
  s.ctx.runMutation = async (ref, args) => {
    if (getFunctionName(ref) === 'projectWork:append') {
      s.tables.hostedProjects.get(s.projectId).owner = 'new-owner';
      s.tables.projectContributors.set('old-owner', {
        _id: 'old-owner',
        projectId: s.projectId,
        contributor: 'owner',
        at: '',
      });
    }
    return append(ref, args);
  };
  await assert.rejects(s.send(command), denied);
  s.ctx.runMutation = append;
  assert.equal(
    s.tables.projectWorkEvents.size,
    0,
    'Atomic append rechecks current owner even when old owner retains ordinary contributor access.',
  );
  s.tables.hostedProjects.get(s.projectId).owner = 'owner';
  await s.send(command);
  const owner = await s.read();
  s.caller('member');
  assert.deepEqual(
    (await s.read()).data,
    owner.data,
    'Existing authorized whole-project Work projection is preserved.',
  );
  s.tables.hostedProjects.get(s.projectId).owner = 'new-owner';
  s.caller('owner');
  await assert.rejects(
    s.send(command, s.preview.revision),
    denied,
    'Original replay does not reinstate old owner authority.',
  );
});
