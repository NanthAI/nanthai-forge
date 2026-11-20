// SPDX-License-Identifier: Apache-2.0
// Purge Lane 1 (Item 4c9e961e, verdict 719bacba): the journal and record purge primitive. No executor exists yet,
// so these tests append the purge through the server's purge step, hand-make the purged rows Lane 2 will write and
// check every reader and replay against them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup, actions, work } from './hosted-planning-fixture.mjs';
import { workRecordRows } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { metadataRequest, applyHostedEvent } from '../dist/work-metadata.js';
import { parseWork } from '../dist/work-unified-types.js';
import { planningWriteSchema } from '../dist/work-planning-types.js';
import { purgedFactsDigest, redactPlanningWrite } from '../dist/work-intent-types.js';
import { itemRows, markPurged, purgeList } from './planning-purge-fixture.mjs';
import { ConvexExchange } from '../dist/exchange-client.js';
import { testDeploymentOrigin } from './trusted-origin.mjs';

const code = expected => error => (error.data?.code ?? error.code) === expected;
const SECRET = 'zebra-purge-fixture';
const { purgeFromServer } = await import(moduleUrl('../convex/projectWorkCommand.ts'));
const redacted = command => redactPlanningWrite(planningWriteSchema.parse(command));

/** Append a purge of a Deleted Item the way the server's purge step does: with its projection, in one mutation,
 * listing every row of the Item (planning-purge-v2). */
async function purgeItem(s, itemId, kind, expectedVersion, ids = [itemId]) {
  const purge = {
    action: 'purge-planning-item',
    operationId: randomUUID(),
    itemId,
    kind,
    expectedVersion,
    deletedAt: '2026-11-20T00:00:00.000Z',
    rows: purgeList(itemRows(s.tables.projectWorkEvents.values(), ids)),
  };
  await purgeFromServer._handler(s.ctx, {
    projectId: s.projectId,
    operationId: purge.operationId,
    command: JSON.stringify(purge),
    owner: 'owner',
  });
  return purge;
}

/** Turn every row the purge lists into the purged form the executor writes: envelope and request hash kept, the
 * command replaced by its redacted copy (words gone, structure kept), marked with the purge. */
function purgeRows(s, _itemId, purge) {
  const listed = new Set(purge.rows.map(([row]) => row));
  markPurged(
    [...s.tables.projectWorkEvents.values()].filter(row => listed.has(row.operationId)),
    purge.operationId,
  );
}

const deleted = (s, itemId, expectedVersion) => {
  const remove = { ...s.item(), itemId, expectedVersion, status: 'deleted' };
  for (const key of ['kind', 'title', 'body', 'intentIds']) delete remove[key];
  return remove;
};

/** An Item with private words, moved to Deleted, commented on, purged by the server's purge step, and every row of
 * it turned into the purged form. */
async function purgedItem(t) {
  const s = await setup(t);
  const create = s.item({ title: `Title ${SECRET}`, body: `Body ${SECRET}` });
  await s.send(create);
  const remove = deleted(s, create.itemId, 1);
  await s.send(remove);
  const comment = {
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId: create.itemId,
    authorLabel: 'Owner',
    text: `Comment ${SECRET}`,
  };
  await s.send(comment);
  const keep = s.item({ title: 'Kept Item' });
  await s.send(keep);
  const purge = await purgeItem(s, create.itemId, 'issue', 2);
  const rows = new Map([...s.tables.projectWorkEvents.values()].map(row => [row.operationId, row]));
  const live = indexRows(s);
  purgeRows(s, create.itemId, purge);
  const pages = async () => {
    const project = s.tables.hostedProjects.get(s.projectId),
      head = [...s.tables.projectWorkHeads.values()].find(row => row.projectId === s.projectId);
    const result = [];
    let cursor = null;
    do {
      const page = await work.events._handler(s.ctx, {
        projectId: s.projectId,
        owner: 'owner',
        initialRevision: project.work.initialRevision,
        revision: head?.revision ?? project.work.revision,
        paginationOpts: { cursor, numItems: 3 },
      });
      result.push(...page.page);
      cursor = page.isDone ? null : page.continueCursor;
    } while (cursor !== null);
    return result;
  };
  return { s, create, remove, comment, keep, purge, rows, live, pages, rebuild: () => rebuild(s) };
}

/** Drop the selected index generation and build a new one from the base checkpoint and the journal. */
async function rebuild(s) {
  const { ensure } = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
  const old = s.tables.hostedProjects.get(s.projectId).work.generationId;
  s.tables.projectWorkGenerations.get(old).format = 3;
  const generation = await ensure._handler(s.ctx, { projectId: s.projectId, rebuild: true });
  assert.notEqual(generation, old, 'a new index generation was built');
  return generation;
}

/** The selected generation's index records. */
function indexRows(s) {
  const project = s.tables.hostedProjects.get(s.projectId),
    generation = s.tables.projectWorkGenerations.get(project.work.generationId),
    partition = generation.recordsGenerationId ?? generation._id;
  return workRecordRows(s.tables).filter(row => row.generationId === partition);
}

test('replay over purged rows rebuilds the Item as words-free history ending in its id-only tombstone', async t => {
  const p = await purgedItem(t);
  // The purge step's own projection already shows the tombstone (the live check ran in that mutation).
  const liveHead = p.live.find(row => row.collection === 'planningItems' && row.key === p.create.itemId);
  assert.deepEqual(
    [JSON.parse(liveHead.value).title, JSON.parse(liveHead.value).version],
    ['Deleted Item', 3],
  );
  await p.rebuild();
  const current = indexRows(p.s);
  const head = current.find(row => row.collection === 'planningItems' && row.key === p.create.itemId);
  const tombstone = JSON.parse(head.value);
  assert.equal(tombstone.title, 'Deleted Item');
  assert.equal(tombstone.body, '');
  assert.equal(tombstone.status, 'deleted');
  assert.equal(tombstone.version, 3);
  assert.deepEqual(tombstone.purged, {
    operationId: p.purge.operationId,
    deletedAt: p.purge.deletedAt,
    by: 'owner',
  });
  assert.equal(
    current.filter(row => row.value.includes(SECRET)).length,
    0,
    'the rebuilt index holds none of the purged words',
  );
  const purgedEvent = current.find(row => row.collection === 'events' && row.key === p.create.operationId);
  assert.equal(JSON.parse(purgedEvent.value).command.action, 'purged-planning-row');
  const kept = current.find(row => row.collection === 'planningItems' && row.key === p.keep.itemId);
  assert.equal(JSON.parse(kept.value).title, 'Kept Item', 'an unpurged Item replays whole');
  // The full replay (export, recovery) keeps the Item's history and Intent, with only the words replaced.
  const data = (await p.s.read()).data;
  assert.deepEqual(
    data.planningItems.filter(item => item.id === p.create.itemId).map(item => [item.version, item.title]),
    [
      [1, 'Deleted Item'],
      [2, 'Deleted Item'],
      [3, 'Deleted Item'],
    ],
  );
  assert.equal(
    data.planningItems.find(item => item.operationId === p.create.operationId).request,
    p.rows.get(p.create.operationId).request,
    'a replayed version keeps the request hash its live write recorded',
  );
  assert.deepEqual(
    data.planningComments.filter(item => item.itemId === p.create.itemId).map(item => item.text),
    ['Deleted comment'],
  );
  assert.ok(
    data.intents.some(intent => intent.id === p.create.itemId),
    'the Item’s Intent replays too',
  );
  assert.equal(JSON.stringify(data).includes(SECRET), false);
});

test('a purged Initiative, a linked Issue and an Issue with Lane activity still replay their dependents', async t => {
  const s = await setup(t);
  const initiative = s.item({ kind: 'initiative', title: `Initiative ${SECRET}` });
  await s.send(initiative);
  const linked = s.item({ title: `Linked ${SECRET}` });
  await s.send(linked);
  await s.send({ action: 'intent-status', intentId: linked.itemId, status: 'ready' });
  // A child names the Initiative and links the Issue; both are created before either is purged.
  const child = s.item({ title: 'Child', initiativeId: initiative.itemId, intentIds: [linked.itemId] });
  await s.send(child);
  await s.send({ ...s.item(), itemId: child.itemId, expectedVersion: 1, title: 'Child edited' });
  const childOf = data => data.planningItems.filter(item => item.id === child.itemId);
  const before = childOf((await s.read()).data);
  for (const [item, kind] of [
    [initiative, 'initiative'],
    [linked, 'issue'],
  ]) {
    await s.send(deleted(s, item.itemId, 1));
    purgeRows(s, item.itemId, await purgeItem(s, item.itemId, kind, 2));
  }
  await rebuild(s);
  assert.equal(indexRows(s).filter(row => row.value.includes(SECRET)).length, 0);
  const data = (await s.read()).data;
  assert.deepEqual(childOf(data), before, 'the child replays exactly, Initiative and link included');
  assert.equal(before.at(-1).initiativeId, initiative.itemId);
  for (const id of [initiative.itemId, linked.itemId])
    assert.equal(
      data.planningItems.filter(item => item.id === id).at(-1).purged?.operationId !== undefined,
      true,
    );
  assert.equal(JSON.stringify(data).includes(SECRET), false);
});

test('event pages verify purged rows: each must hold its own redacted command and name a later purge of its Item', async t => {
  const p = await purgedItem(t);
  const page = await p.pages();
  assert.equal(page.filter(row => row.purged === p.purge.operationId).length, 3);
  const row = p.rows.get(p.create.operationId);
  const facts = JSON.parse(row.command);
  const tamper = async (patch, why) => {
    const before = { ...row };
    Object.assign(row, patch);
    await assert.rejects(p.pages(), code('INVALID_WORK_JOURNAL'), why);
    Object.assign(row, before);
  };
  await tamper({ purged: randomUUID() }, 'a purge that does not exist');
  await tamper({ command: JSON.stringify({ ...facts, itemId: p.keep.itemId }) }, 'another Item');
  await tamper({ command: JSON.stringify({ ...facts, itemId: undefined }) }, 'facts without the Item');
  await tamper({ command: JSON.stringify(p.create) }, 'facts that still hold words');
  await tamper({ command: JSON.stringify({ ...facts, operationId: randomUUID() }) }, 'another operation');
  // A row cannot be purged by a purge that came before it.
  const keepRow = p.rows.get(p.keep.operationId);
  const original = { ...keepRow };
  Object.assign(keepRow, {
    command: JSON.stringify({ ...redacted(p.keep), itemId: p.create.itemId }),
    purged: p.purge.operationId,
  });
  const purgeRow = p.rows.get(p.purge.operationId);
  const purgeRevision = purgeRow.revision;
  purgeRow.revision = keepRow.revision - 1;
  await assert.rejects(
    p.pages(),
    code('INVALID_WORK_JOURNAL'),
    'a purge must come after the rows it removed',
  );
  purgeRow.revision = purgeRevision;
  Object.assign(keepRow, original);
  // The purged form without its marker is never a stored command: the rebuild and the full load both refuse it.
  const unmarked = { ...row };
  Object.assign(row, {
    command: JSON.stringify({
      action: 'purged-planning-row',
      purgeOperationId: randomUUID(),
      command: facts,
    }),
  });
  delete row.purged;
  await assert.rejects(
    p.s.read(),
    code('INVALID_WORK_JOURNAL'),
    'the full load refuses an unmarked purged form',
  );
  await assert.rejects(p.rebuild(), code('INVALID_WORK_JOURNAL'), 'the rebuild refuses it too');
  Object.assign(row, unmarked);
  // A whole purge row that no longer hashes to its request cannot vouch for anything.
  const command = JSON.parse(purgeRow.command);
  purgeRow.command = JSON.stringify({ ...command, itemId: p.keep.itemId });
  await assert.rejects(p.pages(), code('INVALID_WORK_JOURNAL'));
});

test('a retry of the original put answers purged; the same operation with other inputs is refused', async t => {
  const p = await purgedItem(t);
  const resend = command => actionsCommand(p.s, command);
  await assert.rejects(resend(p.create), code('PLANNING_ITEM_PURGED'));
  await assert.rejects(resend(p.comment), code('PLANNING_ITEM_PURGED'));
  await assert.rejects(resend({ ...p.create, title: 'Changed inputs' }), code('WORK_OPERATION_CHANGED'));
});

test('writes, comments and restores on a tombstone are refused with PLANNING_ITEM_PURGED', async t => {
  const p = await purgedItem(t);
  await p.rebuild();
  const restore = { ...p.s.item(), itemId: p.create.itemId, expectedVersion: 3, status: 'open' };
  for (const key of ['kind', 'title', 'body', 'intentIds']) delete restore[key];
  await assert.rejects(p.s.send(restore), code('PLANNING_ITEM_PURGED'));
  await assert.rejects(
    p.s.send({ ...restore, operationId: randomUUID(), title: 'New words' }),
    code('PLANNING_ITEM_PURGED'),
  );
  await assert.rejects(
    p.s.send({
      action: 'comment-planning-item',
      operationId: randomUUID(),
      itemId: p.create.itemId,
      authorLabel: 'Owner',
      text: 'After purge',
    }),
    code('PLANNING_ITEM_PURGED'),
  );
  // Other Items are untouched by the tombstone.
  await p.s.send({ ...p.s.item(), itemId: p.keep.itemId, expectedVersion: 1, title: 'Kept and edited' });
  // Only the server's purge step writes a purge: no client entry accepts it, even for the owner.
  const purgeKeep = { ...p.purge, operationId: randomUUID(), itemId: p.keep.itemId, expectedVersion: 1 };
  await assert.rejects(p.s.send(purgeKeep), code('BAD_ARGUMENT'));
  // The journal writer refuses a purge that comes without its projection (its live checks never ran).
  await assert.rejects(
    work.append._handler(p.s.ctx, {
      projectId: p.s.projectId,
      owner: 'owner',
      operationId: purgeKeep.operationId,
      request: metadataRequest(purgeKeep),
      previousRevision: (await p.s.read()).data.revision,
      command: JSON.stringify(purgeKeep),
    }),
    code('BAD_ARGUMENT'),
  );
  // The purge step itself takes only a purge, and only of a Deleted Item at its version.
  const step = command =>
    purgeFromServer._handler(p.s.ctx, {
      projectId: p.s.projectId,
      operationId: command.operationId,
      command: JSON.stringify(command),
      owner: 'owner',
    });
  await assert.rejects(step({ ...p.s.item(), title: 'Not a purge' }), code('BAD_ARGUMENT'));
  await assert.rejects(
    step({ ...purgeKeep, expectedVersion: 2 }),
    code('BAD_ARGUMENT'),
    'an edited Item is open',
  );
  const data = (await p.s.read()).data;
  assert.equal(data.schema >= 16, true, 'the fixture runs the unified (schema 16+) reducer');
});

test('exportJournal refuses purged rows to a caller without planning-purge-v2 and names them to one with it', async t => {
  const s = await setup(t);
  const item = s.item();
  await s.send(item);
  await s.send(deleted(s, item.itemId, 1));
  await purgeItem(s, item.itemId, 'issue', 2);
  await assert.rejects(
    actions.exportJournal._handler(s.ctx, { projectId: s.projectId }),
    code('CLI_UPGRADE_REQUIRED'),
    'a purge whose rows are not yet redacted is already a form an older CLI cannot replay',
  );
  const p = await purgedItem(t);
  await assert.rejects(
    actions.exportJournal._handler(p.s.ctx, { projectId: p.s.projectId }),
    code('CLI_UPGRADE_REQUIRED'),
  );
  await assert.rejects(
    actions.exportJournal._handler(p.s.ctx, { projectId: p.s.projectId, purgedRows: true }),
    code('CLI_UPGRADE_REQUIRED'),
    'a planning-purge-v1 CLI cannot replay v2 purges',
  );
  const journal = JSON.parse(
    await actions.exportJournal._handler(p.s.ctx, { projectId: p.s.projectId, purgedRows: 2 }),
  );
  assert.match(journal.coverage, /3 purged row\(s\) keep their operation envelope and structure/);
  assert.equal(JSON.stringify(journal).includes(SECRET), false);
  const { hostedJournalSchema } = await import('../dist/work-metadata.js');
  assert.equal(hostedJournalSchema.parse(journal).events.length, journal.events.length);
});

test('a purged record version answers PLANNING_ITEM_PURGED, and a marker naming no purge stays a failure', async t => {
  const p = await purgedItem(t);
  const { hostedRecordBody } = await import(moduleUrl('../convex/projectHostedRecords.ts'));
  const bodyId = await p.s.ctx.db.insert('projectHostedRecordBodies', {
    projectId: p.s.projectId,
    value: '',
  });
  const row = {
    _id: 'record',
    _creationTime: 1,
    projectId: p.s.projectId,
    kind: 'issue',
    key: p.create.itemId,
    parent: '',
    status: 'deleted',
    version: 1,
    bodyId,
    digest: 'a'.repeat(64),
    bytes: 10,
    purged: p.purge.operationId,
  };
  await assert.rejects(hostedRecordBody(p.s.ctx, row), code('PLANNING_ITEM_PURGED'));
  await assert.rejects(
    hostedRecordBody(p.s.ctx, { ...row, kind: 'comment', key: randomUUID(), parent: p.create.itemId }),
    code('PLANNING_ITEM_PURGED'),
  );
  await assert.rejects(
    hostedRecordBody(p.s.ctx, { ...row, purged: randomUUID() }),
    code('SOURCE_UNAVAILABLE'),
  );
  await assert.rejects(hostedRecordBody(p.s.ctx, { ...row, key: p.keep.itemId }), code('SOURCE_UNAVAILABLE'));
  await assert.rejects(hostedRecordBody(p.s.ctx, { ...row, kind: 'lane' }), code('SOURCE_UNAVAILABLE'));
});

test('a stored-body purged row reuses the archived envelope and answers like a legacy one', async t => {
  const p = await purgedItem(t);
  const events = await import(moduleUrl('../convex/projectWorkEventStore.ts'));
  const operationId = randomUUID(),
    command = { ...p.create, operationId, title: `Other ${SECRET}` };
  const fields = {
    projectId: p.s.projectId,
    value: '',
    operationId,
    revision: 1,
    request: metadataRequest(command),
    actor: 'owner',
    at: '2026-11-20T00:00:00.000Z',
    journalCommand: JSON.stringify(redacted(command)),
  };
  // A whole purge row in the work-store table reads like any whole row, and vouches for the rows it lists.
  const keptOperation = randomUUID(),
    keptFacts = redacted({ ...p.keep, operationId: keptOperation });
  const storedPurge = {
      ...p.purge,
      operationId: randomUUID(),
      itemId: p.keep.itemId,
      rows: [
        [operationId, purgedFactsDigest(redacted(command))],
        [keptOperation, purgedFactsDigest(keptFacts)],
      ],
    },
    purgeFields = {
      projectId: p.s.projectId,
      value: '',
      operationId: storedPurge.operationId,
      revision: 99,
      request: metadataRequest(storedPurge),
      actor: 'owner',
      at: '2026-11-20T00:00:00.000Z',
      command: JSON.stringify(storedPurge),
    };
  const purgeId = await p.s.ctx.db.insert('projectHostedRecordBodies', purgeFields);
  fields.purged = storedPurge.operationId;
  const id = await p.s.ctx.db.insert('projectHostedRecordBodies', fields);
  assert.equal(
    JSON.parse(events.eventDocument({ ...purgeFields, _id: purgeId, _creationTime: 1 }).command).action,
    'purge-planning-item',
  );
  const { verifyPurgedEvents } = await import(moduleUrl('../convex/projectWorkPurgedRows.ts'));
  const keptRow = {
    operationId: keptOperation,
    revision: 2,
    command: JSON.stringify(keptFacts),
    purged: storedPurge.operationId,
  };
  await verifyPurgedEvents(p.s.ctx, p.s.projectId, [keptRow]);
  await assert.rejects(
    verifyPurgedEvents(p.s.ctx, p.s.projectId, [{ ...keptRow, revision: 100 }]),
    code('INVALID_WORK_JOURNAL'),
  );
  const document = events.eventDocument({ ...fields, _id: id, _creationTime: 1 });
  assert.equal(document.purged, storedPurge.operationId);
  assert.equal(document.command, fields.journalCommand);
  await assert.rejects(
    events.findWorkEvent(p.s.ctx, p.s.projectId, operationId, { command: JSON.stringify(command) }),
    code('PLANNING_ITEM_PURGED'),
  );
  await assert.rejects(
    events.findWorkEvent(p.s.ctx, p.s.projectId, operationId, {
      command: JSON.stringify({ ...command, title: 'Different' }),
    }),
    code('WORK_OPERATION_CHANGED'),
  );
  const envelope = await events.findWorkEvent(p.s.ctx, p.s.projectId, operationId, { authority: true });
  assert.equal(envelope.request, fields.request);
  // A purged row with a segment, or with its command still present, is not the purged form.
  assert.throws(
    () => events.eventDocument({ ...fields, _id: id, _creationTime: 1, journalSegment: '1' }),
    code('INVALID_WORK_JOURNAL'),
  );
  assert.throws(
    () => events.eventDocument({ ...fields, _id: id, _creationTime: 1, command: JSON.stringify(command) }),
    code('INVALID_WORK_JOURNAL'),
  );
});

test('the reducer purges only a Deleted Item at its version, once', () => {
  const data = parseWork({ schema: 8, revision: 0, intents: [], lanes: [], views: [] });
  const project = randomUUID(),
    archive = 'b'.repeat(64),
    itemId = randomUUID();
  let revision = 0;
  const apply = command => {
    const event = {
      projectKey: project,
      archiveSha256: archive,
      id: command.operationId,
      actor: 'owner',
      at: '2026-11-20T00:00:00.000Z',
      request: metadataRequest(command),
      previousRevision: revision,
      command,
    };
    const result = applyHostedEvent(data, event);
    revision++;
    return result;
  };
  const put = patch => ({
    action: 'put-planning-item',
    operationId: randomUUID(),
    itemId,
    ...patch,
  });
  apply(put({ expectedVersion: 0, kind: 'issue', title: 'Open Item' }));
  const purge = expectedVersion => ({
    action: 'purge-planning-item',
    operationId: randomUUID(),
    itemId,
    kind: 'issue',
    expectedVersion,
    deletedAt: '2026-11-20T00:00:00.000Z',
    rows: [],
  });
  assert.throws(() => apply(purge(1)), code('BAD_ARGUMENT'), 'an open Item is not purged');
  apply(put({ expectedVersion: 1, status: 'deleted' }));
  assert.throws(() => apply(purge(1)), code('ITEM_CHANGED'));
  // A replay checks the same way: the purged rows before it replay as their redacted commands.
  apply(purge(2));
  const latest = data.planningItems.at(-1);
  assert.equal(latest.title, 'Deleted Item');
  assert.equal(latest.purged.by, 'owner');
  assert.throws(() => apply(purge(3)), code('PLANNING_ITEM_PURGED'));
  assert.throws(() => apply(put({ expectedVersion: 3, status: 'open' })), code('PLANNING_ITEM_PURGED'));
});

test('a legacy source-return after a purged row is checked by envelope continuity and says so', () => {
  const data = parseWork({ schema: 8, revision: 0, intents: [], lanes: [], views: [] });
  const project = randomUUID(),
    archive = 'c'.repeat(64),
    itemId = randomUUID(),
    purgeId = randomUUID();
  const sourceReturn = previousRevision => ({
    projectKey: project,
    archiveSha256: archive,
    id: randomUUID(),
    actor: 'owner',
    at: '2026-11-20T00:00:00.000Z',
    previousRevision,
    command: {
      action: 'source-return',
      archiveSha256: archive,
      workSha256: 'd'.repeat(64),
      previousArchiveSha256: archive,
      previousRevision: 0,
    },
  });
  const unpurged = sourceReturn(0);
  assert.throws(
    () =>
      applyHostedEvent(structuredClone(data), { ...unpurged, request: metadataRequest(unpurged.command) }),
    code('INVALID_WORK_JOURNAL'),
    'without a purged row the pinned digest still binds',
  );
  const operationId = randomUUID();
  const purgedRow = command => ({
    projectKey: project,
    archiveSha256: archive,
    id: operationId,
    actor: 'owner',
    at: '2026-11-20T00:00:00.000Z',
    request: 'e'.repeat(64),
    previousRevision: 0,
    command: { action: 'purged-planning-row', purgeOperationId: purgeId, command },
  });
  const put = { action: 'put-planning-item', operationId, itemId, kind: 'issue', title: `Words ${SECRET}` };
  assert.throws(
    () => applyHostedEvent(structuredClone(data), purgedRow(put)),
    /still holds words/,
    'a purged row cannot carry text',
  );
  applyHostedEvent(data, purgedRow(redacted(put)));
  const after = sourceReturn(1);
  assert.equal(
    applyHostedEvent(data, { ...after, request: metadataRequest(after.command) }),
    'envelope-continuity',
  );
  assert.equal(data.revision, 2);
});

test('the CLI asks for purged rows in its one journal read, and drops the argument only for an older server', async t => {
  const exchange = new ConvexExchange(
    testDeploymentOrigin('https://fixture.invalid'),
    'synthetic',
    'project',
    randomUUID(),
    null,
  );
  const calls = [];
  let older = false;
  t.mock.method(exchange.client, 'action', async (_ref, input) => {
    calls.push(structuredClone(input));
    if (older && input.purgedRows)
      throw Error(
        'ArgumentValidationError: Object contains extra field `purgedRows` that is not in the validator.',
      );
    return 'journal';
  });
  assert.equal(await exchange.journal(), 'journal');
  assert.deepEqual(calls, [{ projectId: 'project', purgedRows: 2 }], 'one call on a current server');
  older = true;
  calls.length = 0;
  assert.equal(await exchange.journal(), 'journal');
  assert.deepEqual(calls, [{ projectId: 'project', purgedRows: 2 }, { projectId: 'project' }]);
});

async function actionsCommand(s, command) {
  return actions.command._handler(s.ctx, {
    projectId: s.projectId,
    operationId: command.operationId,
    revision: (await s.read()).data.revision,
    command: JSON.stringify(command),
  });
}
