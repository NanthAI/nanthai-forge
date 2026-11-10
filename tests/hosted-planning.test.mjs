// SPDX-License-Identifier: Apache-2.0
import { workRecordRows } from './hosted-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { digest } from '../dist/hash.js';
import { setup, actions, work } from './hosted-planning-fixture.mjs';
import { readHosted } from './hosted-read.mjs';
import { moduleUrl } from './convex-module.mjs';
import { meterReads } from './hosted-read-set.mjs';
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
      if (!dropped && getFunctionName(ref) === 'projectWorkCommand:commandFromAction') {
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
  const unrelated = {
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId: first.itemId,
    authorLabel: '',
    text: 'Independent write',
  };
  assert.equal((await s.send(unrelated, current.data.revision - 1)).operationId, unrelated.operationId);
  const planned = s.item({ itemId: first.itemId, expectedVersion: 1, title: 'Concurrent edit' }),
    append = s.ctx.runMutation;
  let raced = false;
  s.ctx.runMutation = async (ref, args) => {
    if (
      !raced &&
      getFunctionName(ref) === 'projectWorkCommand:commandFromAction' &&
      args.operationId === planned.operationId
    ) {
      raced = true;
      await s.send(
        s.item({ itemId: first.itemId, expectedVersion: 1, title: 'Other retained version' }),
        current.data.revision,
      );
    }
    return append(ref, args);
  };
  await assert.rejects(s.send(planned, current.data.revision), error => error.data.code === 'ITEM_CHANGED');
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
    if (getFunctionName(ref) === 'projectWorkCommand:commandFromAction') {
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
    workRecordRows(s.tables).some(row => row.collection === 'planningVersions:payload'),
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
  // The reader compare names it too: the store reader refuses a body that fails its digest.
  assert.equal(changed.readComments.invalid, changed.planningComments.different);
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

// Flip 5 S4 (Issue 0695ab24): with `workStore: 'records'` the web and agent planning reads
// (projectWorkIndex:records and :detail) come from the record store, and they return what the journal
// reads returned: the same items, versions and comments in the same order, with Intent notes on the
// same id left out of the comments.
test('with the store reader on, planning lists, versions, comments and detail read the record store and equal the journal reads', async t => {
  const { dispatchHostedWork } = await import('../dist/hosted-work-client.js');
  const store = await import(moduleUrl('../convex/projectWorkStore.ts'));
  const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));
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
  const first = s.item({ title: 'First' });
  await s.send(first);
  await run({ action: 'copy-work-store' });
  await run({ action: 'set-work-store', mode: 'dual' });
  const second = s.item({ title: 'Second', body: 'Done when: read from the store' });
  await s.send(second);
  await s.send({ ...first, operationId: randomUUID(), expectedVersion: 1, status: 'closed' });
  for (const text of ['One', 'Two'])
    await s.send({
      action: 'comment-planning-item',
      operationId: randomUUID(),
      itemId: second.itemId,
      text,
      authorLabel: 'Owner',
    });
  // A note on the Issue's own Intent is a `comment` record with the same parent; it is not a comment.
  await s.send({ action: 'note', intentId: second.itemId, text: 'A note', kind: 'comment' });
  const initial = await s.read(),
    intentId = randomUUID();
  await actions.command._handler(s.ctx, {
    projectId: s.projectId,
    operationId: intentId,
    revision: initial.data.revision,
    command: JSON.stringify({
      action: 'intent',
      outcome: 'Moves',
      constraints: '',
      base: initial.sourceHead,
    }),
  });
  await s.send({ action: 'note', intentId, text: 'First note', kind: 'comment' });
  await s.send({ action: 'note', intentId, text: 'Decided', kind: 'decision' });
  await s.send({ action: 'intent-status', intentId, status: 'completed' });
  const page = (collection, extra = {}) =>
    index.records._handler(s.ctx, {
      projectId: s.projectId,
      collection,
      paginationOpts: { cursor: null, numItems: 100 },
      ...extra,
    });
  const reads = async () => {
    const shown = result => result.page.map(row => [row.id, JSON.parse(row.value)]);
    return {
      list: shown(await page('planningItems')),
      newest: shown(await page('planningItems', { newestFirst: true })),
      versions: shown(await page('planningVersions', { parentId: first.itemId })),
      comments: shown(await page('planningComments', { parentId: second.itemId, newestFirst: true })),
      notes: shown(await page('notes', { parentId: intentId })),
      issueNotes: shown(await page('notes', { parentId: second.itemId })),
      moves: shown(await page('lifecycle', { parentId: intentId })),
      detail: JSON.parse(
        (
          await index.detail._handler(s.ctx, {
            projectId: s.projectId,
            collection: 'planningItems',
            id: second.itemId,
          })
        ).value,
      ),
    };
  };
  const journal = await reads();
  assert.deepEqual(
    [
      journal.list.length,
      journal.versions.length,
      journal.comments.map(([, c]) => c.text),
      journal.notes.map(([, n]) => n.text),
      journal.issueNotes.length,
      journal.moves.map(([, m]) => m.to),
    ],
    [2, 2, ['Two', 'One'], ['First note', 'Decided'], 1, ['completed']],
  );
  // Spend freeze 2026-11-10: a store page reads no more documents or bytes than the journal page it
  // replaces. Each head keeps its current value, so a page reads one document per row (before: head,
  // record and body for an Issue; record and body for a comment, and the Issue's notes as well).
  const body = `Done when: the page costs no more.\n${'Planned work in ordinary words. '.repeat(20)}`;
  for (let i = 0; i < 20; i++) {
    await s.send(s.item({ title: `Issue ${i}`, body }));
    await s.send({
      action: 'comment-planning-item',
      operationId: randomUUID(),
      itemId: second.itemId,
      text: `Comment ${i}: ${'about the work. '.repeat(8)}`,
      authorLabel: 'Owner',
    });
  }
  const meter = meterReads(s.ctx);
  const costs = async () => ({
    list: await meter.cost(() => page('planningItems', { newestFirst: true })),
    comments: await meter.cost(() =>
      page('planningComments', { parentId: second.itemId, newestFirst: true }),
    ),
    notes: await meter.cost(() => page('notes', { parentId: intentId })),
    detail: await meter.cost(() =>
      index.detail._handler(s.ctx, {
        projectId: s.projectId,
        collection: 'planningItems',
        id: second.itemId,
      }),
    ),
  });
  const journalCost = await costs();
  const fromJournal = await reads();
  assert.deepEqual(await run({ action: 'set-work-store', mode: 'records' }), {
    mode: 'records',
    changed: true,
  });
  const storeCost = await costs();
  meter.restore();
  console.log(JSON.stringify({ journalCost, storeCost }));
  for (const name of ['list', 'comments', 'notes', 'detail'])
    assert.ok(
      storeCost[name].documents <= journalCost[name].documents &&
        storeCost[name].bytes <= journalCost[name].bytes,
      `${name}: store ${JSON.stringify(storeCost[name])}, journal ${JSON.stringify(journalCost[name])}`,
    );
  assert.equal(storeCost.notes.documents, journalCost.notes.documents, 'notes: one document per note');
  const fromStore = await reads();
  assert.deepEqual(fromStore, fromJournal);
  // Heads stored before heads kept their value, with a note's kind as its status (dogfood's copy): the
  // reader falls back to record and body, and the copy brings each one up to date once.
  const old = [...s.tables.projectHostedRecordHeads.values()].filter(head => head.value !== undefined);
  for (const head of old) {
    delete head.value;
    if (head.status === 'note') head.status = 'comment';
  }
  assert.deepEqual(
    { ...(await reads()), notes: fromJournal.notes, issueNotes: fromJournal.issueNotes },
    fromJournal,
    'a head without its value reads its body; a note never shows as a comment',
  );
  const refresh = async () =>
    Object.values((await run({ action: 'copy-work-store' })).collections).reduce(
      (sum, total) => sum + (total.refreshed ?? 0),
      0,
    );
  assert.deepEqual([await refresh(), await refresh()], [old.length, 0]);
  assert.deepEqual(await reads(), fromJournal);
  // The reader compare opens the body too: an inline value that drifted from it shows as different.
  const drifted = [...s.tables.projectHostedRecordHeads.values()].find(head => head.status === 'comment'),
    kept = drifted.value;
  drifted.value = JSON.stringify({ ...JSON.parse(kept), text: 'Changed' });
  assert.equal((await run({ action: 'compare-work-store' })).collections.readComments.different, 1);
  drifted.value = kept;
  // The reader compare checks every journal row against what the store reader returns for it.
  const compared = (await run({ action: 'compare-work-store' })).collections;
  for (const name of ['readItems', 'readVersions', 'readComments', 'readNotes', 'readLifecycle'])
    assert.deepEqual(
      [compared[name].missing, compared[name].different, compared[name].matched > 0],
      [0, 0, true],
      name,
    );
  // A bounded sample (spend freeze 2026-11-10): newest rows only, at most `newest` per collection.
  const headsBeforeDigests = [...s.tables.projectHostedRecordHeads.values()].map(head =>
    structuredClone(head),
  );
  const baseline = await run({ action: 'copy-work-store', digestsOnly: true, newest: 200 });
  assert.ok(Object.values(baseline.collections).every(total => total.copied === 0));
  assert.deepEqual(
    [...s.tables.projectHostedRecordHeads.values()],
    headsBeforeDigests,
    'digest baseline never refreshes or recopies old heads',
  );
  const originalGet = s.ctx.db.get;
  s.ctx.db.get = id => {
    assert.ok(!s.tables.projectHostedRecordBodies.has(id), 'equal hashes never fetch full bodies');
    return originalGet(id);
  };
  const sample = await run({ action: 'compare-work-store', newest: 1 });
  s.ctx.db.get = originalGet;
  assert.equal(sample.newest, 1);
  for (const [name, total] of Object.entries(sample.collections)) {
    assert.ok(total.checked <= 1, name);
    assert.deepEqual([total.missing, total.different, total.invalid], [0, 0, 0], name);
  }
  assert.equal(sample.collections.readComments.checked, 1);
  const compareMeter = meterReads(s.ctx);
  const oldClient = {
    ...client,
    query: (ref, args) => {
      const full = { ...args };
      full.digestOnly = false;
      return handlers[getFunctionName(ref)]._handler(s.ctx, full);
    },
  };
  const fullCompareCost = await compareMeter.cost(() =>
    dispatchHostedWork(oldClient, s.projectId, { action: 'compare-work-store', newest: 200 }),
  );
  const digestCompareCost = await compareMeter.cost(() => run({ action: 'compare-work-store', newest: 200 }));
  assert.ok(
    digestCompareCost.bytes < fullCompareCost.bytes,
    JSON.stringify({ fullCompareCost, digestCompareCost }),
  );
  const withoutMethod = totals =>
    Object.fromEntries(
      Object.entries(totals).map(([name, total]) => {
        const copy = { ...total };
        delete copy.method;
        return [name, copy];
      }),
    );
  assert.deepEqual(
    withoutMethod((await run({ action: 'compare-work-store', newest: 200 })).collections),
    withoutMethod(
      (await dispatchHostedWork(oldClient, s.projectId, { action: 'compare-work-store', newest: 200 }))
        .collections,
    ),
  );
  compareMeter.restore();
  console.log(JSON.stringify({ migrationCompare: { fullCompareCost, digestCompareCost } }));
  const historical = [...s.tables.projectHostedRecords.values()].find(row => row.kind === 'issue');
  const readerHash = historical.workReadDigest;
  delete historical.workReadDigest;
  const historicalCache = workRecordRows(s.tables).find(
    row =>
      row.collection === '_workStoreDigests:planningVersions' &&
      JSON.parse(row.value).ref.key === historical.key &&
      JSON.parse(row.value).ref.version === historical.version,
  );
  const historicalValue = historicalCache.value;
  const missingMetadata = JSON.parse(historicalValue);
  delete missingMetadata.stored;
  historicalCache.value = JSON.stringify(missingMetadata);
  const oldVersion = (await run({ action: 'compare-work-store', newest: 200 })).collections.readVersions;
  assert.deepEqual(
    [oldVersion.different, oldVersion.invalid, oldVersion.missing],
    [0, 0, 0],
    'a historical version without derived hash metadata uses its verified full reader',
  );
  historical.workReadDigest = readerHash;
  historicalCache.value = historicalValue;
  const corrupt = [...s.tables.projectHostedRecords.values()].find(row => row.kind === 'comment');
  const originalDigest = corrupt.digest;
  corrupt.digest = '0'.repeat(64);
  let fetchedBodies = 0;
  s.ctx.db.get = id => {
    if (s.tables.projectHostedRecordBodies.has(id)) fetchedBodies++;
    return originalGet(id);
  };
  const fullMismatch = await run({ action: 'compare-work-store' });
  assert.ok(
    fullMismatch.collections.planningComments.different + fullMismatch.collections.notes.different > 0,
    'full verification catches out-of-band immutable header corruption',
  );
  fetchedBodies = 0;
  const targetCaches = workRecordRows(s.tables).filter(
    row =>
      (row.collection === '_workStoreHeads:comment' || row.collection.startsWith('_workStoreDigests:')) &&
      JSON.parse(row.value).ref?.key === corrupt.key,
  );
  const cacheValues = targetCaches.map(row => row.value);
  for (const row of targetCaches) {
    const value = JSON.parse(row.value);
    if (row.collection === '_workStoreHeads:comment') value.ref.digest = corrupt.digest;
    else if (value.stored) value.stored.ref.digest = corrupt.digest;
    row.value = JSON.stringify(value);
  }
  const mismatch = await run({ action: 'compare-work-store', newest: 200 });
  assert.ok(mismatch.collections.planningComments.different + mismatch.collections.notes.different > 0);
  assert.ok(fetchedBodies > 0, 'a digest mismatch fetches the retained body for diagnosis');
  s.ctx.db.get = originalGet;
  corrupt.digest = originalDigest;
  targetCaches.forEach((row, i) => {
    row.value = cacheValues[i];
  });

  // Writes keep both stores current while the store serves reads.
  await s.send({
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId: second.itemId,
    text: 'Three',
    authorLabel: 'Owner',
  });
  const texts = async () => (await reads()).comments.map(([, c]) => c.text.split(':')[0]);
  const expected = ['Three', ...Array.from({ length: 20 }, (_, i) => `Comment ${19 - i}`), 'Two', 'One'];
  assert.deepEqual(await texts(), expected);
  await run({ action: 'set-work-store', mode: 'dual' });
  assert.deepEqual(await texts(), expected, 'switching back reads the journal, which has every write');
});

test('bounded digest comparisons retain 200-record coverage and pin full fallback across page boundaries', async t => {
  const { dispatchHostedWork } = await import('../dist/hosted-work-client.js');
  const store = await import(moduleUrl('../convex/projectWorkStore.ts'));
  const mutation = await import(moduleUrl('../convex/projectWorkCommand.ts'));
  const s = await setup(t);
  s.tables.hostedProjects.get(s.projectId).sourceAuthority = { mode: 'server', epoch: 1 };
  s.tables.hostedProjects.get(s.projectId).workStore = 'records';
  const issue = s.item({ title: 'Digest page boundaries' });
  await s.send(issue);
  for (let i = 0; i < 205; i++)
    await mutation.command._handler(s.ctx, {
      projectId: s.projectId,
      operationId: randomUUID(),
      command: JSON.stringify({
        action: 'note',
        intentId: issue.itemId,
        kind: 'comment',
        text: `${i}: ${'rationale '.repeat(350)}`,
      }),
    });
  const handlers = { 'projectWorkStore:copy': store.copy, 'projectWorkStore:compare': store.compare };
  const client = {
    query: (ref, args) => handlers[getFunctionName(ref)]._handler(s.ctx, args),
    mutation: (ref, args) => handlers[getFunctionName(ref)]._handler(s.ctx, args),
    action: () => assert.fail('no action'),
  };
  const run = input => dispatchHostedWork(client, s.projectId, input);
  const cold = await run({ action: 'compare-work-store', newest: 201 });
  assert.ok(Object.values(cold.collections).every(total => total.method === 'full'));
  assert.equal(cold.collections.notes.checked, 201);
  const heads = structuredClone([...s.tables.projectHostedRecordHeads.values()]);
  const seeded = await run({ action: 'copy-work-store', digestsOnly: true, newest: 200 });
  assert.equal(seeded.collections.notes.fingerprinted, 200);
  assert.deepEqual([...s.tables.projectHostedRecordHeads.values()], heads);
  const meter = meterReads(s.ctx);
  const digestCost = await meter.cost(() => run({ action: 'compare-work-store', newest: 200 }));
  const warm = await run({ action: 'compare-work-store', newest: 200 });
  assert.equal(warm.collections.notes.checked, 200);
  assert.equal(warm.collections.readNotes.checked, 200);
  assert.ok(
    Object.values(warm.collections).every(
      total =>
        total.method === 'digest' && total.different === 0 && total.invalid === 0 && total.missing === 0,
    ),
  );
  const beyond = await run({ action: 'compare-work-store', newest: 201 });
  assert.equal(beyond.collections.notes.checked, 201);
  assert.equal(beyond.collections.notes.method, 'full');
  const legacyClient = {
    ...client,
    query: (ref, args) => handlers[getFunctionName(ref)]._handler(s.ctx, { ...args, digestOnly: false }),
  };
  const fullCost = await meter.cost(() =>
    dispatchHostedWork(legacyClient, s.projectId, { action: 'compare-work-store', newest: 200 }),
  );
  assert.ok(digestCost.bytes < fullCost.bytes / 2, JSON.stringify({ digestCost, fullCost }));
  meter.restore();
  console.log(JSON.stringify({ migrationCompare200: { digestCost, fullCost } }));
  const insert = s.ctx.db.insert;
  let failed = false;
  s.ctx.db.insert = (table, value) => {
    if (table === 'projectHostedRecords' && !failed) {
      failed = true;
      throw Error('Synthetic dual-write failure');
    }
    return insert(table, value);
  };
  const operationId = randomUUID();
  const accepted = await mutation.command._handler(s.ctx, {
    projectId: s.projectId,
    operationId,
    command: JSON.stringify({
      action: 'note',
      intentId: issue.itemId,
      kind: 'comment',
      text: 'Journal remains accepted after dual-store failure',
    }),
  });
  s.ctx.db.insert = insert;
  assert.equal(accepted.operationId, operationId);
  const failedDual = await run({ action: 'compare-work-store', newest: 200 });
  assert.equal(failedDual.collections.notes.method, 'digest');
  assert.ok(failedDual.collections.notes.missing > 0, 'independent journal hash exposes a failed dual write');
  await store.setMode._handler(s.ctx, { projectId: s.projectId, mode: 'journal' });
  await mutation.command._handler(s.ctx, {
    projectId: s.projectId,
    operationId: randomUUID(),
    command: JSON.stringify({
      action: 'note',
      intentId: issue.itemId,
      kind: 'comment',
      text: 'Journal-only interval',
    }),
  });
  await store.setMode._handler(s.ctx, { projectId: s.projectId, mode: 'records' });
  const resumed = await run({ action: 'compare-work-store', newest: 200 });
  assert.equal(resumed.collections.notes.method, 'full');
  assert.ok(resumed.collections.notes.missing > 0, 'a mode gap cannot reuse stale hash coverage');
});

test('frozen Work writers retain replay, export, rebuild and note projections without journal appends', async t => {
  const store = await import(moduleUrl('../convex/projectWorkStore.ts'));
  const commands = await import(moduleUrl('../convex/projectWorkCommand.ts'));
  const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));
  const { hostedBriefRecords } = await import(moduleUrl('../convex/projectBriefingContext.ts'));
  const retained = await import(moduleUrl('../convex/projectWorkEventStore.ts'));
  const { ensure } = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
  const s = await setup(t);
  const project = s.tables.hostedProjects.get(s.projectId);
  project.sourceAuthority = { mode: 'server', epoch: 1 };
  await store.setMode._handler(s.ctx, { projectId: s.projectId, mode: 'records', writers: [] });
  const base = (await s.read()).sourceHead;
  const intentId = randomUUID();
  const send = (command, operationId = command.operationId ?? randomUUID()) =>
    commands.command._handler(s.ctx, {
      projectId: s.projectId,
      operationId,
      command: JSON.stringify(command),
    });
  const put = s.item();
  await send(put);
  await send({ action: 'intent', outcome: 'Retained replay', constraints: '', base }, intentId);
  await send({ action: 'note', intentId, text: 'Before freeze', kind: 'comment' });
  const frozen = ['note', 'intent', 'intent-status', 'planning'];
  await store.setMode._handler(s.ctx, { projectId: s.projectId, mode: 'records', writers: frozen });
  for (const collection of [
    'planningVersions',
    'planningComments',
    'notes',
    'intents',
    'lifecycle',
    'planningItems',
    'issueHeads',
  ])
    await store.copy._handler(s.ctx, {
      projectId: s.projectId,
      collection,
      cursor: null,
      newest: 200,
      digestsOnly: true,
    });
  const journalSize = s.tables.projectWorkEvents.size;
  const note = { action: 'note', intentId, text: 'After freeze', kind: 'decision' };
  const noteId = randomUUID();
  const receipt = await send(note, noteId);
  assert.deepEqual(await send(note, noteId), receipt, 'unknown outcome replays its canonical receipt');
  await assert.rejects(
    send({ ...note, text: 'Changed retry' }, noteId),
    e => e.data?.code === 'WORK_OPERATION_CHANGED',
  );
  await send({ action: 'intent', outcome: 'Frozen creation', constraints: '', base });
  await send({ action: 'intent-status', intentId, status: 'completed' });
  await send({ ...put, operationId: randomUUID(), expectedVersion: 1, title: 'Retained update' });
  await send({
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId: put.itemId,
    text: 'Retained comment',
    authorLabel: 'Owner',
  });
  assert.equal(s.tables.projectWorkEvents.size, journalSize);
  const events = [...s.tables.projectHostedRecordBodies.values()].filter(row => row.operationId);
  assert.equal(events.length, 5);
  assert.ok(
    events.every(row => !row.bodyId),
    'one retained row per event, no second body or head',
  );
  // Primary projects no longer maintain migration fingerprints. Explicit comparisons must open
  // current records, even if an old baseline was seeded after the switch.
  const digestNotes = JSON.parse(
    await store.compare._handler(s.ctx, {
      projectId: s.projectId,
      collection: 'readNotes',
      cursor: null,
      newest: 200,
    }),
  );
  assert.equal(digestNotes.method, 'full');
  assert.deepEqual(
    [digestNotes.different.count, digestNotes.missing.count, digestNotes.invalid.count],
    [0, 0, 0],
  );
  const expected = await s.read();
  assert.equal(expected.data.intents.find(i => i.id === intentId).notes.length, 2);
  assert.equal(expected.data.intents.find(i => i.id === intentId).status, 'completed');
  const pages = async () => {
    const result = [];
    let cursor = null;
    do {
      const page = await work.events._handler(s.ctx, {
        projectId: s.projectId,
        owner: 'owner',
        initialRevision: project.work.initialRevision,
        revision: expected.data.revision,
        paginationOpts: { cursor, numItems: 2 },
      });
      result.push(...page.page);
      cursor = page.isDone ? null : page.continueCursor;
    } while (cursor !== null);
    return result;
  };
  const mixed = await pages();
  assert.equal(mixed.length, expected.events.length);
  const detail = async () =>
    index.detail._handler(s.ctx, { projectId: s.projectId, collection: 'intents', id: intentId });
  const beforeDetail = await detail();
  const brief = () => hostedBriefRecords(s.ctx, project, { intentId });
  const beforeBrief = await brief();
  assert.equal(beforeBrief.records.intents[0].notes.length, 2);
  const beforeExport = await actions.exportPlanning._handler(s.ctx, { projectId: s.projectId });
  // Compare identical retained commands through both physical layouts, with the same project flags.
  const meter = meterReads(s.ctx);
  const canonicalCost = await meter.cost(pages);
  const canonicalBriefCost = await meter.cost(brief);
  const canonicalDetailCost = await meter.cost(detail);
  for (const event of events) {
    const { _id, _creationTime, ...value } = retained.eventDocument(event);
    s.tables.projectWorkEvents.set(_id, { ...value, _id, _creationTime });
    s.tables.projectHostedRecordBodies.delete(_id);
  }
  const journalCost = await meter.cost(pages);
  const journalBriefCost = await meter.cost(brief);
  const journalDetailCost = await meter.cost(detail);
  assert.deepEqual(canonicalBriefCost, journalBriefCost);
  assert.deepEqual(canonicalDetailCost, journalDetailCost);
  assert.deepEqual(await brief(), beforeBrief);
  meter.restore();
  assert.ok(
    canonicalCost.documents <= journalCost.documents && canonicalCost.bytes <= journalCost.bytes,
    JSON.stringify({ canonicalCost, journalCost }),
  );
  assert.deepEqual(await pages(), mixed);
  assert.deepEqual((await s.read()).data, expected.data);
  assert.deepEqual(await detail(), beforeDetail);
  assert.equal(await actions.exportPlanning._handler(s.ctx, { projectId: s.projectId }), beforeExport);
  for (const event of events) {
    s.tables.projectWorkEvents.delete(event._id);
    s.tables.projectHostedRecordBodies.set(event._id, event);
  }
  await ensure._handler(s.ctx, { projectId: s.projectId, rebuild: true });
  assert.deepEqual((await s.read()).data, expected.data, 'index rebuild replays retained canonical events');
  const rebuilt = await detail();
  assert.equal(JSON.parse(rebuilt.value).noteCount, 2);
  assert.equal(rebuilt.editable, beforeDetail.editable);
  assert.equal(rebuilt.intentPin, beforeDetail.intentPin);
  await send({ action: 'intent-status', intentId, status: 'completed' });
  assert.equal(
    s.tables.projectWorkEvents.size,
    journalSize,
    'a no-op status retains its primary Intent version too',
  );
  await store.setMode._handler(s.ctx, { projectId: s.projectId, mode: 'records', writers: [] });
  const rollback = JSON.parse(
    await store.compare._handler(s.ctx, {
      projectId: s.projectId,
      collection: 'readNotes',
      cursor: null,
      newest: 200,
    }),
  );
  assert.equal(
    rollback.method,
    'full',
    'writer rollback invalidates fingerprints skipped during primary writes',
  );
  assert.equal(rollback.different.count + rollback.missing.count + rollback.invalid.count, 0);
  await store.setMode._handler(s.ctx, { projectId: s.projectId, mode: 'records', writers: frozen });
  assert.equal((await s.read()).data.intents.find(i => i.id === intentId).status, 'completed');
  // A damaged retained row never silently replays different source.
  const damaged = events[0],
    original = damaged.command;
  damaged.command = JSON.stringify({ ...note, text: 'Damaged retained command' });
  await assert.rejects(pages(), e => e.data?.code === 'SOURCE_UNAVAILABLE');
  damaged.command = original;
  console.log(
    JSON.stringify({
      frozenWorkReplay: {
        canonicalCost,
        journalCost,
        canonicalBriefCost,
        journalBriefCost,
        canonicalDetailCost,
        journalDetailCost,
      },
    }),
  );
});

test('mixed retained history pages large planning commands once across planning freeze and rollback', async t => {
  const s = await setup(t);
  const store = await import(moduleUrl('../convex/projectWorkStore.ts'));
  const commands = await import(moduleUrl('../convex/projectWorkCommand.ts'));
  const project = s.tables.hostedProjects.get(s.projectId);
  project.sourceAuthority = { mode: 'server', epoch: 1 };
  const initial = await s.read(),
    intentId = randomUUID();
  const send = (command, operationId = command.operationId ?? randomUUID()) =>
    commands.command._handler(s.ctx, {
      projectId: s.projectId,
      operationId,
      command: JSON.stringify(command),
    });
  await send(
    { action: 'intent', outcome: 'Large history replay', constraints: '', base: initial.sourceHead },
    intentId,
  );
  await store.setMode._handler(s.ctx, { projectId: s.projectId, mode: 'records', writers: ['note'] });
  const big = s.item({ body: 'Original large body\n'.repeat(18000) });
  await send(big);
  await send({ action: 'note', intentId, text: 'Mixed legacy planning', kind: 'comment' });
  await send({
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId: big.itemId,
    text: 'Large legacy comment\n'.repeat(18000),
    authorLabel: 'Owner',
  });
  await store.setMode._handler(s.ctx, {
    projectId: s.projectId,
    mode: 'records',
    writers: ['note', 'planning'],
  });
  await send({ ...big, operationId: randomUUID(), expectedVersion: 1, title: 'Large retained update' });
  await send({ action: 'intent-status', intentId, status: 'completed' });
  await send({
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId: big.itemId,
    text: 'Large retained comment\n'.repeat(18000),
    authorLabel: 'Owner',
  });
  await store.setMode._handler(s.ctx, { projectId: s.projectId, mode: 'records', writers: ['note'] });
  await send({ ...big, operationId: randomUUID(), expectedVersion: 2, title: 'Legacy after rollback' });
  await send({ action: 'note', intentId, text: 'Retained after rollback', kind: 'comment' });
  const expected = await s.read();
  // Convex allows one .paginate() per query. Crossing epochs must use indexed streams,
  // while the explicit byte budget still splits a page without reading any operation twice.
  const query = s.ctx.db.query;
  s.ctx.db.query = table => {
    const result = query(table);
    if (['projectWorkEvents', 'projectHostedRecordBodies'].includes(table))
      result.paginate = () => assert.fail('mixed retained history cannot use Convex paginate across epochs');
    return result;
  };
  const seen = new Set();
  let cursor = null,
    calls = 0;
  do {
    const page = await work.events._handler(s.ctx, {
      projectId: s.projectId,
      owner: 'owner',
      initialRevision: project.work.initialRevision,
      revision: expected.data.revision,
      paginationOpts: { cursor, numItems: 100, maximumBytesRead: 500000 },
    });
    calls++;
    for (const row of page.page) {
      assert.ok(!seen.has(row.operationId));
      seen.add(row.operationId);
    }
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor !== null);
  assert.deepEqual(
    [...seen],
    expected.events.map(event => event.id),
  );
  assert.ok(calls <= 5, 'byte windows and flag boundaries add no caller page calls');
  assert.deepEqual((await s.read()).data, expected.data);
  s.ctx.db.query = query;
});
