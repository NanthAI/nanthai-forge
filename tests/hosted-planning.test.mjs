// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { digest } from '../dist/hash.js';
import { setup, actions, work } from './hosted-planning-fixture.mjs';
import { readHosted } from './hosted-read.mjs';
import { moduleUrl } from './convex-module.mjs';
const denied = error => error.data?.code === 'PROJECT_UNAVAILABLE';

test('whole-project hosted planning creates a planned Intent, preserves versions/labels and reconciles a lost original reply', async t => {
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
    assert.equal(after.data.intents.length, 1);
    assert.equal(after.sourceHead, before.sourceHead);
    for (const key of ['lanes', 'views', 'runs', 'channelMoves', 'hostedChannelMoves'])
      assert.deepEqual(after.data[key], before.data[key]);
    const exported = JSON.parse(await actions.exportPlanning._handler(s.ctx, { projectId: s.projectId })),
      manifest = JSON.parse(exported.json);
    assert.equal(exported.sha256, digest(exported.json));
    assert.equal(manifest.kind, 'forge-hosted-planning');
    assert.deepEqual(manifest.items, after.data.planningItems);
    assert.deepEqual(manifest.comments, after.data.planningComments);
    // The planned Intent (id = Issue id) is the Issue's link although its stored intentIds is empty (0b12fcfe).
    assert.deepEqual(
      manifest.linkedIntents.map(item => item.id),
      after.data.intents.map(item => item.id),
    );
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
      ['NOT_FOUND', 'BAD_ARGUMENT', 'ITEM_CHANGED'].includes(error.data.code),
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
  await assert.rejects(s.send(planned), error => error.data.code === 'ITEM_CHANGED');
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

// Flip 5 S1/S2 (Issue 0695ab24): no work may be lost moving planning into the Work store.
test('the Work store copy moves every Issue version, comment and note once, and the compare finds nothing missing or changed', async t => {
  const { dispatchHostedWork } = await import('../dist/hosted-work-client.js');
  const store = await import(moduleUrl('../convex/projectWorkStore.ts'));
  const s = await setup(t);
  s.tables.hostedProjects.get(s.projectId).sourceAuthority = { mode: 'server', epoch: 1 };
  const initial = await s.read(),
    intentId = randomUUID();
  await actions.command._handler(s.ctx, {
    projectId: s.projectId,
    operationId: intentId,
    revision: initial.data.revision,
    command: JSON.stringify({
      action: 'intent',
      outcome: 'Noted',
      constraints: '',
      base: initial.sourceHead,
    }),
  });
  await s.send({ action: 'note', intentId, text: 'First note', kind: 'comment' });
  await s.send({ action: 'note', intentId, text: 'Chosen', kind: 'decision' });
  const initiative = s.item({ kind: 'initiative', title: 'Group' });
  await s.send(initiative);
  // A body over the index's row limit is stored in parts; the copy joins them.
  const issue = s.item({ title: 'Large', body: 'word '.repeat(12000), initiativeId: initiative.itemId });
  await s.send(issue);
  await s.send({ ...issue, operationId: randomUUID(), expectedVersion: 1, status: 'in-progress' });
  for (const text of ['Why', 'Evidence'])
    await s.send({
      action: 'comment-planning-item',
      operationId: randomUUID(),
      itemId: issue.itemId,
      text,
      authorLabel: 'Owner',
    });
  assert(
    [...s.tables.projectWorkRecords.values()].some(row => row.collection === 'planningVersions:payload'),
    'the large body is stored in parts',
  );
  const handlers = { 'projectWorkStore:copy': store.copy, 'projectWorkStore:compare': store.compare };
  const client = {
    query: (ref, args) => handlers[getFunctionName(ref)]._handler(s.ctx, args),
    mutation: (ref, args) => handlers[getFunctionName(ref)]._handler(s.ctx, args),
    action: () => assert.fail('no action'),
  };
  const run = action =>
    dispatchHostedWork(client, s.projectId, { action }).then(result => result.collections);
  const before = await run('compare-work-store');
  assert.deepEqual(
    [before.planningVersions.missing, before.planningComments.missing, before.notes.missing],
    [3, 2, 2],
  );
  const copied = await run('copy-work-store');
  assert.deepEqual(
    [copied.planningVersions.copied, copied.planningComments.copied, copied.notes.copied],
    [3, 2, 2],
  );
  const compared = await run('compare-work-store');
  for (const [name, total] of Object.entries(compared))
    assert.deepEqual([total.missing, total.different, total.invalid], [0, 0, 0], name);
  assert.equal(compared.planningItems.matched, 2);
  assert.equal(compared.issueHeads.matched, 2);
  const head = [...s.tables.projectHostedRecordHeads.values()].find(row => row.key === issue.itemId);
  assert.deepEqual(
    [head.kind, head.version, head.status, head.parent],
    ['issue', 2, 'in-progress', initiative.itemId],
  );
  // A second run is a no-op: everything is already stored with the same digest.
  const again = await run('copy-work-store');
  assert.deepEqual([again.planningVersions.copied, again.planningVersions.same, again.notes.same], [0, 3, 2]);
  // A stored version with other bytes is reported by both, and the copy never overwrites it.
  const stored = [...s.tables.projectHostedRecords.values()].find(row => row.kind === 'comment');
  stored.digest = 'f'.repeat(64);
  const changed = await run('compare-work-store');
  assert.equal(changed.planningComments.different + changed.notes.different, 1);
  const kept = await run('copy-work-store');
  assert.equal(kept.planningComments.different + kept.notes.different, 1);
  assert.equal(stored.digest, 'f'.repeat(64));
  // Owner only, and only for a hosted-authority project.
  s.tables.projectContributors.set('contributor', {
    _id: 'contributor',
    projectId: s.projectId,
    contributor: 'member',
  });
  s.caller('member');
  await assert.rejects(run('copy-work-store'), error => error.code === 'PROJECT_UNAVAILABLE');
  await assert.rejects(run('compare-work-store'), error => error.code === 'PROJECT_UNAVAILABLE');
  s.caller('owner');
  delete s.tables.hostedProjects.get(s.projectId).sourceAuthority;
  await assert.rejects(run('copy-work-store'), error => error.code === 'BAD_ARGUMENT');
});

test('with dual write on, each planning write stores its Issue version, comment or note in the same mutation; journal-only stores none', async t => {
  const { dispatchHostedWork } = await import('../dist/hosted-work-client.js');
  const store = await import(moduleUrl('../convex/projectWorkStore.ts'));
  const s = await setup(t);
  s.tables.hostedProjects.get(s.projectId).sourceAuthority = { mode: 'server', epoch: 1 };
  const handlers = {
    'projectWorkStore:copy': store.copy,
    'projectWorkStore:compare': store.compare,
    'projectWorkStore:setMode': store.setMode,
  };
  const client = {
    query: (ref, args) => handlers[getFunctionName(ref)]._handler(s.ctx, args),
    mutation: (ref, args) => handlers[getFunctionName(ref)]._handler(s.ctx, args),
    action: () => assert.fail('no action'),
  };
  const run = input => dispatchHostedWork(client, s.projectId, input);
  const records = () => s.tables.projectHostedRecords.size;
  const early = s.item({ title: 'Before dual' });
  await s.send(early);
  assert.equal(records(), 0, 'journal-only writes store no record');
  assert.equal((await run({ action: 'copy-work-store' })).collections.planningVersions.copied, 1);
  assert.deepEqual(await run({ action: 'set-work-store', mode: 'dual' }), { mode: 'dual', changed: true });
  const initial = await s.read(),
    intentId = randomUUID();
  await actions.command._handler(s.ctx, {
    projectId: s.projectId,
    operationId: intentId,
    revision: initial.data.revision,
    command: JSON.stringify({ action: 'intent', outcome: 'Dual', constraints: '', base: initial.sourceHead }),
  });
  const issue = s.item({ title: 'Large', body: 'word '.repeat(12000) });
  await s.send(issue);
  await s.send({ ...early, operationId: randomUUID(), expectedVersion: 1, status: 'closed' });
  await s.send({
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId: issue.itemId,
    text: 'Why',
    authorLabel: 'Owner',
  });
  await s.send({ action: 'note', intentId, text: 'A note', kind: 'comment' });
  const compared = (await run({ action: 'compare-work-store' })).collections;
  for (const [name, total] of Object.entries(compared))
    assert.deepEqual([total.missing, total.different, total.invalid], [0, 0, 0], name);
  assert.deepEqual(
    [
      compared.planningVersions.matched,
      compared.planningComments.matched,
      compared.notes.matched,
      compared.issueHeads.matched,
    ],
    [3, 1, 1, 2],
  );
  const head = [...s.tables.projectHostedRecordHeads.values()].find(row => row.key === early.itemId);
  assert.deepEqual([head.version, head.status], [2, 'closed']);
  // Switching back stops the dual write; the journal keeps every write.
  assert.deepEqual(await run({ action: 'set-work-store', mode: 'journal' }), {
    mode: 'journal',
    changed: true,
  });
  const before = records();
  await s.send({
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId: issue.itemId,
    text: 'Later',
    authorLabel: 'Owner',
  });
  assert.equal(records(), before);
  assert.equal((await s.read()).data.planningComments.length, 2);
  s.caller('stranger');
  await assert.rejects(
    run({ action: 'set-work-store', mode: 'dual' }),
    error => error.code === 'PROJECT_UNAVAILABLE',
  );
});

// Flip 5 (Issue 0695ab24): web Intents and the Intent each Issue is join the hosted `intent` kind, and
// their status moves become `lifecycle` records, with nothing lost; once a Lane pins an Intent, the
// journal copy never overwrites it.
test('journal Intents and lifecycle copy into the record store, the dual write keeps them current, and a pinned Intent is left alone', async t => {
  const { dispatchHostedWork } = await import('../dist/hosted-work-client.js');
  const store = await import(moduleUrl('../convex/projectWorkStore.ts'));
  const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
  const s = await setup(t);
  s.tables.hostedProjects.get(s.projectId).sourceAuthority = { mode: 'server', epoch: 1 };
  const handlers = {
    'projectWorkStore:copy': store.copy,
    'projectWorkStore:compare': store.compare,
    'projectWorkStore:setMode': store.setMode,
  };
  const client = {
    query: (ref, args) => handlers[getFunctionName(ref)]._handler(s.ctx, args),
    mutation: (ref, args) => handlers[getFunctionName(ref)]._handler(s.ctx, args),
    action: () => assert.fail('no action'),
  };
  const run = input => dispatchHostedWork(client, s.projectId, input).then(result => result.collections);
  const clean = totals => {
    for (const [name, total] of Object.entries(totals))
      assert.deepEqual([total.missing, total.different, total.invalid], [0, 0, 0], name);
  };
  const initial = await s.read(),
    intentId = randomUUID();
  await actions.command._handler(s.ctx, {
    projectId: s.projectId,
    operationId: intentId,
    revision: initial.data.revision,
    command: JSON.stringify({
      action: 'intent',
      outcome: 'Web',
      constraints: 'Keep',
      base: initial.sourceHead,
    }),
  });
  const issue = s.item({ title: 'Planned' });
  await s.send(issue);
  // Closing the Issue moves its Intent's status: one lifecycle entry in the journal.
  await s.send({ ...issue, operationId: randomUUID(), expectedVersion: 1, status: 'closed' });
  const before = await run({ action: 'compare-work-store' });
  assert.deepEqual([before.intents.missing, before.lifecycle.missing], [2, 1]);
  const copied = await run({ action: 'copy-work-store' });
  assert.deepEqual([copied.intents.copied, copied.lifecycle.copied], [2, 1]);
  clean(await run({ action: 'compare-work-store' }));
  const head = id =>
    [...s.tables.projectHostedRecordHeads.values()].find(r => r.kind === 'intent' && r.key === id);
  const body = id =>
    JSON.parse(
      s.tables.projectHostedRecordBodies.get(s.tables.projectHostedRecords.get(head(id).recordId).bodyId)
        .value,
    );
  const web = body(intentId);
  assert.deepEqual(
    [web.outcome, web.constraints, web.base, web.creatorAccountId, web.status, head(intentId).status],
    ['Web', 'Keep', { head: initial.sourceHead }, 'owner', 'active', 'journal:active'],
    'a web Intent keeps its base, with no landing receipt',
  );
  assert(
    !('notes' in web) && !('lifecycle' in web.journal) && web.journal.createdAt,
    'notes and lifecycle are records',
  );
  assert.deepEqual([body(issue.itemId).status, 'base' in body(issue.itemId)], ['completed', false]);
  assert.equal((await run({ action: 'copy-work-store' })).intents.same, 2, 'a second copy stores nothing');
  // Dual write: a status move is the Intent's next version plus one lifecycle record; a note changes
  // neither the Intent nor its version.
  await run({ action: 'set-work-store', mode: 'dual' });
  await s.send({ action: 'note', intentId, text: 'Context', kind: 'comment' });
  assert.equal(head(intentId).version, 0);
  await s.send({ action: 'intent-status', intentId, status: 'completed' });
  assert.deepEqual([head(intentId).version, head(intentId).status], [1, 'journal:completed']);
  const moves = [...s.tables.projectHostedRecordHeads.values()].filter(r => r.kind === 'lifecycle');
  assert.deepEqual(
    moves.map(r => [r.parent, r.status]).sort(),
    [
      [intentId, 'completed'],
      [issue.itemId, 'completed'],
    ].sort(),
  );
  clean(await run({ action: 'compare-work-store' }));
  // A Lane pinned the Intent (a base with a receipt): hosted paths own it from here.
  const pinned = {
    ...body(intentId),
    version: 2,
    base: { head: initial.sourceHead, receiptId: 'main-1' },
    status: 'active',
  };
  await records.writeHostedRecord(s.ctx, {
    projectId: s.projectId,
    actor: 'owner',
    authorityEpoch: 1,
    expectedVersion: 1,
    record: pinned,
  });
  await s.send({ action: 'intent-status', intentId, status: 'abandoned' });
  assert.deepEqual([head(intentId).version, body(intentId).status], [2, 'active'], 'never overwritten');
  const after = await run({ action: 'compare-work-store' });
  clean(after);
  assert.equal(after.intents.hosted, 1);
  assert.equal((await run({ action: 'copy-work-store' })).intents.hosted, 1);
});
