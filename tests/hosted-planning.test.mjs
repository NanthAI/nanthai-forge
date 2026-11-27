// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { workRecordRows } from './hosted-fixture.mjs';
import test from 'node:test';
import { workEventRows } from './work-event-fixture.mjs';
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
    assert.equal(workEventRows(s.tables).length, 2);
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
    // A signed-in writer's typed label is never stored: the server records who wrote it (Item 9a3d6f5f, C1-10).
    assert.equal(after.data.planningComments[0].authorLabel, '');
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
    count = workEventRows(s.tables).length;
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
  assert.equal(workEventRows(s.tables).length, count);
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
  assert.equal(workEventRows(s.tables).length, 0);
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
    workEventRows(s.tables).length,
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

test('planning writes retain Issue versions, comments, notes and heads', async t => {
  const s = await setup(t);
  s.tables.hostedProjects.get(s.projectId).sourceAuthority = { mode: 'server', epoch: 1 };
  const records = () => s.tables.projectHostedRecords.size;
  const early = s.item({ title: 'Before the P8 bridge' });
  await s.send(early);
  assert.ok(records() > 0, 'canonical planning writes precede any migration mode change');
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
  const head = [...s.tables.projectHostedRecordHeads.values()].find(row => row.key === early.itemId);
  assert.deepEqual([head.version, head.status], [2, 'closed']);
  const before = records();
  await s.send({
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId: issue.itemId,
    text: 'Later',
    authorLabel: 'Owner',
  });
  assert.equal(records(), before + 1);
  assert.equal((await s.read()).data.planningComments.length, 2);
});

test('planning lists, versions, comments and detail read canonical records', async t => {
  const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));
  const s = await setup(t);
  s.tables.hostedProjects.get(s.projectId).sourceAuthority = { mode: 'server', epoch: 1 };
  const first = s.item({ title: 'First' });
  await s.send(first);
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
  // A store page reads no more documents than its journal equivalent. Its byte budget has one
  // explicit exception: the Item head's status-time pin eliminates version reads on dated pages.
  // Comments and notes get no allowance, and an Item still costs one head document.
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
  const beforeCleanup = await reads();
  const old = [...s.tables.projectHostedRecordHeads.values()].filter(head => head.value !== undefined);
  for (const head of old) {
    delete head.value;
    if (head.status === 'note') head.status = 'comment';
  }
  assert.deepEqual(
    { ...(await reads()), notes: beforeCleanup.notes, issueNotes: beforeCleanup.issueNotes },
    beforeCleanup,
    'a head without its value reads its body; a note never shows as a comment',
  );
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
});

test('frozen Work writers retain replay, export, rebuild and note projections without journal appends', async t => {
  const commands = await import(moduleUrl('../convex/projectWorkCommand.ts'));
  const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));
  const { hostedBriefRecords } = await import(moduleUrl('../convex/projectBriefingContext.ts'));
  const { ensure } = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
  const s = await setup(t);
  const project = s.tables.hostedProjects.get(s.projectId);
  project.sourceAuthority = { mode: 'server', epoch: 1 };
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

  const beforeWindow = new Set(workEventRows(s.tables).map(row => row._id));
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
  const events = workEventRows(s.tables).filter(row => !beforeWindow.has(row._id));
  assert.equal(events.length, 5);
  assert.ok(
    events.every(row => !row.bodyId),
    'one retained row per event, no second body or head',
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
  await ensure._handler(s.ctx, { projectId: s.projectId, rebuild: true });
  assert.deepEqual((await s.read()).data, expected.data, 'index rebuild replays retained canonical events');
  assert.equal(await actions.exportPlanning._handler(s.ctx, { projectId: s.projectId }), beforeExport);
  assert.deepEqual(await brief(), beforeBrief);
  const rebuilt = await detail();
  assert.equal(JSON.parse(rebuilt.value).noteCount, 2);
  assert.equal(rebuilt.editable, beforeDetail.editable);
  assert.equal(rebuilt.intentPin, beforeDetail.intentPin);
  await send({ action: 'intent-status', intentId, status: 'completed' });
  assert.equal((await s.read()).data.intents.find(i => i.id === intentId).status, 'completed');
  // A damaged retained row never silently replays different source.
  const damaged = events[0],
    original = damaged.command;
  damaged.command = JSON.stringify({ ...note, text: 'Damaged retained command' });
  await assert.rejects(pages(), e => e.data?.code === 'SOURCE_UNAVAILABLE');
  damaged.command = original;
});

test('mixed retained history pages large planning commands once across historical writer epochs', async t => {
  const s = await setup(t);
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

  const big = s.item({ body: 'Original large body\n'.repeat(18000) });
  await send(big);
  await send({ action: 'note', intentId, text: 'Mixed legacy planning', kind: 'comment' });
  // Comments stay under the 65,536-character cap; the Item bodies above and below carry the large commands.
  await send({
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId: big.itemId,
    text: 'Large legacy comment\n'.repeat(2800),
    authorLabel: 'Owner',
  });

  await send({ ...big, operationId: randomUUID(), expectedVersion: 1, title: 'Large retained update' });
  await send({ action: 'intent-status', intentId, status: 'completed' });
  await send({
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId: big.itemId,
    text: 'Large retained comment\n'.repeat(2800),
    authorLabel: 'Owner',
  });

  await send({ ...big, operationId: randomUUID(), expectedVersion: 2, title: 'Legacy after rollback' });
  await send({ action: 'note', intentId, text: 'Retained after rollback', kind: 'comment' });
  const expected = await s.read();
  // Convex allows one .paginate() per query. Crossing epochs must use indexed streams,
  // while the explicit byte budget still splits a page without reading any operation twice.
  const query = s.ctx.db.query;
  s.ctx.db.query = table => {
    const result = query(table);
    if (table === 'projectHostedRecordBodies')
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
