// SPDX-License-Identifier: Apache-2.0
// Purge executor (Item 4c9e961e, purge Lanes 2 and 3): selection, the atomic first step, redaction of every store
// (the work store's Intent versions, lifecycle versions and handoff summaries included), the completeness check before
// purgedAt, resume after a crash and after an index rebuild, and the row limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { metadataRequest } from '../dist/work-metadata.js';
import { digest } from '../dist/hash.js';
import { encodeArchiveBytes } from '../dist/landing-capsule-bytes.js';
import { journalFragmentTexts } from '../dist/journal-fragments.js';
import { journalSegmentText, journalTablePins } from '../dist/journal-segment.js';
import { getFunctionName } from 'convex/server';
import { setup, actions } from './hosted-planning-fixture.mjs';
import { workRecordRows } from './hosted-fixture.mjs';
import { meterWorkIO } from './hosted-read-set.mjs';
import { moduleUrl } from './convex-module.mjs';

const SECRET = 'quokka-executor-fixture';
const code = expected => error => (error.data?.code ?? error.code) === expected;
const modules = {
  projectPlanningPurge: await import(moduleUrl('../convex/projectPlanningPurge.ts')),
  projectPlanningPurgeSelect: await import(moduleUrl('../convex/projectPlanningPurgeSelect.ts')),
  projectPlanningPurgeSegmentRun: await import(moduleUrl('../convex/projectPlanningPurgeSegmentRun.ts')),
  projectPlanningPurgeSegments: await import(moduleUrl('../convex/projectPlanningPurgeSegments.ts')),
  projectPlanningPurgeArchiveSelection: await import(
    moduleUrl('../convex/projectPlanningPurgeArchiveSelection.ts')
  ),
  projectJournalRead: await import(moduleUrl('../convex/projectJournalRead.ts')),
  projectJournalCapture: await import(moduleUrl('../convex/projectJournalCapture.ts')),
  projectJournalPublish: await import(moduleUrl('../convex/projectJournalPublish.ts')),
  projectJournalRun: await import(moduleUrl('../convex/projectJournalRun.ts')),
};
const { ensure } = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
const { purgeSteps, partitionsOf } = await import(moduleUrl('../convex/projectPlanningPurgeRedact.ts'));
const workStore = await import(moduleUrl('../convex/projectWorkStore.ts'));
const workIndex = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const { commandPlanningRows } = await import(moduleUrl('../convex/projectWorkCommandRows.ts'));
const hostedRecords = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const { successorIntentId } = await import('../dist/hosted-intent-chain.js');
const { dispatchHostedWork } = await import('../dist/hosted-work-client.js');
const { indexedRecord } = await import('../dist/work-hosted-index.js');

/** Route the executor's internal calls to their handlers; `crash` throws before the given redaction call. */
function executor(s, crash = Infinity, beforeCall) {
  const calls = { query: 0, mutation: 0, redact: 0, action: 0 };
  const route = kind => {
    const original = s.ctx[kind];
    return (ref, args) => {
      const [module, name] = getFunctionName(ref).split(':');
      const target = modules[module]?.[name];
      if (!target) return original(ref, args);
      calls[kind.slice(3).toLowerCase()]++;
      if (name === 'redact' && ++calls.redact > crash) throw new Error('executor stopped');
      beforeCall?.(module, name, args);
      return target._handler(kind === 'runAction' ? ctx : s.ctx, args);
    };
  };
  const ctx = {
    ...s.ctx,
    runQuery: route('runQuery'),
    runMutation: route('runMutation'),
    runAction: route('runAction'),
  };
  return {
    calls,
    ctx,
    run: (itemId, operationId) =>
      modules.projectPlanningPurge.run._handler(ctx, { projectId: s.projectId, itemId, operationId }),
  };
}
const secretRows = s =>
  Object.entries(s.tables).flatMap(([table, rows]) =>
    [...rows.values()]
      .filter(row => JSON.stringify(row).includes(SECRET))
      .map(
        row =>
          `${table}:${row.collection ?? ''}:${row.key ?? row.operationId ?? ''}:${row.generationId ?? ''}:${JSON.stringify(row).slice(0, 160)}`,
      ),
  );

/** Work store mode for the fixture: copy the store and write both (`dual`) before the Item exists, so the store
 * holds every version; `records` makes the store the primary reader before the Item is Deleted. */
async function storeMode(s, mode) {
  const handlers = {
    'projectWorkStore:copy': workStore.copy,
    'projectWorkStore:compare': workStore.compare,
    'projectWorkStore:setMode': workStore.setMode,
  };
  const client = {
    query: (ref, args) => handlers[getFunctionName(ref)]._handler(s.ctx, args),
    mutation: (ref, args) => handlers[getFunctionName(ref)]._handler(s.ctx, args),
    action: () => assert.fail('no action'),
  };
  if (mode === 'dual') {
    s.tables.hostedProjects.get(s.projectId).sourceAuthority = { mode: 'server', epoch: 1 };
    await dispatchHostedWork(client, s.projectId, { action: 'copy-work-store' });
  }
  await dispatchHostedWork(client, s.projectId, { action: 'set-work-store', mode });
}

/** An alias of the Intent in the selected index, as a folded Issue leaves one (src/work-intent-converter.ts). */
function addAlias(s, intentId) {
  const project = s.tables.hostedProjects.get(s.projectId);
  const generationId = project.work.generationId,
    aliasId = randomUUID();
  const [entry] = indexedRecord('intentAliases', aliasId, '', 0, { aliasId, intentId });
  s.ctx.db.insert('projectWorkRecords', { ...entry, projectId: s.projectId, generationId });
  return aliasId;
}

/** An Item (Intent-born unless `intentBorn` is false) with two versions, a comment, a decision comment and a note,
 * then Deleted; and a kept Item. `records`: the work store is written from the start and primary when the Item is
 * Deleted, and one comment is written through an alias of the Item. */
async function deletedItem(t, { records = false, intentBorn = true, large = false, useAlias = true } = {}) {
  const s = await setup(t);
  if (records) await storeMode(s, 'dual');
  const initial = await s.read(),
    itemId = randomUUID();
  if (intentBorn)
    await actions.command._handler(s.ctx, {
      projectId: s.projectId,
      operationId: itemId,
      revision: initial.data.revision,
      command: JSON.stringify({
        action: 'intent',
        outcome: `Outcome ${SECRET}`,
        constraints: `Constraints ${SECRET}`,
        base: initial.sourceHead,
      }),
    });
  // `large`: a body over 32 KB (an index payload whose header lists the files it names) and 40 more comments, so
  // every paged step takes more than one page.
  const body = large
    ? `Body ${SECRET} words, see src/${SECRET}/file.ts\n${'Planned work in ordinary words. '.repeat(1100)}`
    : `Body ${SECRET} words`;
  await s.send(s.item({ itemId, title: `Title ${SECRET}`, body }));
  await s.send({
    ...s.item({ itemId, expectedVersion: 1, ...(large ? { body } : {}) }),
    title: `Retitled ${SECRET}`,
    reason: `Why ${SECRET}`,
  });
  await s.send({
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId,
    authorLabel: 'agent',
    text: `Comment ${SECRET}`,
  });
  await s.send({
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId,
    authorLabel: 'agent',
    text: `Decision ${SECRET}`,
    decision: true,
  });
  await s.send({ action: 'note', intentId: itemId, text: `Note ${SECRET}`, kind: 'comment' });
  for (let n = 0; large && n < 40; n++)
    await s.send({
      action: 'comment-planning-item',
      operationId: randomUUID(),
      itemId,
      authorLabel: 'agent',
      text: `Comment ${n} ${SECRET}`,
    });
  const read = await s.read(),
    current = read.data.planningItems.filter(item => item.id === itemId).at(-1);
  const deleted = {
    action: 'put-planning-item',
    operationId: randomUUID(),
    itemId,
    expectedVersion: current.version,
    status: 'deleted',
  };
  const keep = s.item({ title: 'Kept Item' });
  let alias;
  if (!records) {
    await s.send(deleted);
    await s.send(keep);
  } else {
    if (useAlias) alias = addAlias(s, itemId);
    await storeMode(s, 'records');
    await s.send(keep);
    // The alias lives in the index only (a real one comes from the base checkpoint, which a full read replays from),
    // so the last two writes pass their revision instead of reading the whole journal.
    const revision = (await s.read()).data.revision;
    if (alias)
      await s.send(
        {
          action: 'comment-planning-item',
          operationId: randomUUID(),
          itemId: alias,
          authorLabel: 'agent',
          text: `Alias comment ${SECRET}`,
        },
        revision,
      );
    await s.send(deleted, revision + (alias ? 1 : 0));
  }
  assert.ok(secretRows(s).length > 0, 'the fixture holds the words before the purge');
  return { s, itemId, keep, alias };
}

test('a purge redacts every store, checks completeness before purgedAt, and no table holds the words after', async t => {
  const { s, itemId, keep } = await deletedItem(t);
  const operationId = randomUUID(),
    run = executor(s);
  const done = await run.run(itemId, operationId);
  assert.equal(typeof done.purgedAt, 'number', 'marked done only after the completeness check');
  assert.ok(done.rows >= 7, 'intent, puts, comments, note and the Deleted put are listed');
  assert.deepEqual(secretRows(s), [], 'no table holds the purged words');
  // Nothing comes back: not on a rebuild, not in a full load, not in an export.
  const project = s.tables.hostedProjects.get(s.projectId);
  s.tables.projectWorkGenerations.get(project.work.generationId).format = 3;
  await ensure._handler(s.ctx, { projectId: s.projectId, rebuild: true });
  assert.deepEqual(secretRows(s), [], 'a rebuild brings no words back');
  const data = (await s.read()).data;
  assert.equal(JSON.stringify(data).includes(SECRET), false);
  assert.equal(data.planningItems.filter(item => item.id === keep.itemId).at(-1).title, 'Kept Item');
  const journal = await actions.exportJournal._handler(s.ctx, { projectId: s.projectId, purgedRows: 2 });
  assert.equal(journal.includes(SECRET), false);
  // A second run of the same purge is a no-op that reports the same finished purge.
  assert.deepEqual(await executor(s).run(itemId, operationId), done);
});

test('a purge stopped mid-way never reports done and resumes, also after an index rebuild', async t => {
  const { s, itemId } = await deletedItem(t);
  const operationId = randomUUID();
  await assert.rejects(executor(s, 3).run(itemId, operationId), /executor stopped/);
  const partial = await modules.projectPlanningPurge.status._handler(s.ctx, {
    projectId: s.projectId,
    operationId,
  });
  assert.equal(partial.purgedAt, undefined, 'an unfinished purge is not done');
  assert.ok(secretRows(s).length > 0, 'words remain until the purge resumes');
  const project = s.tables.hostedProjects.get(s.projectId);
  s.tables.projectWorkGenerations.get(project.work.generationId).format = 3;
  await ensure._handler(s.ctx, { projectId: s.projectId, rebuild: true });
  const done = await executor(s).run(itemId, operationId);
  assert.equal(typeof done.purgedAt, 'number');
  assert.deepEqual(secretRows(s), []);
});

test('review 2026-11-20 finding 1: a partition kept from before the purge (Intent migration) loses the Item root, search row and payloads too, across pages and a crash', async t => {
  const { s, itemId } = await deletedItem(t, { large: true });
  const project = s.tables.hostedProjects.get(s.projectId);
  const kept = project.work.generationId;
  const generation = s.tables.projectWorkGenerations.get(kept);
  generation.format = 3;
  generation.retainedForIntentMigration = true;
  await ensure._handler(s.ctx, { projectId: s.projectId, rebuild: true });
  assert.notEqual(project.work.generationId, kept, 'a new partition is selected');
  const inKept = () => secretRows(s).filter(row => row.includes(kept));
  assert.ok(
    inKept().some(row => row.includes(':planningSearch:')) &&
      inKept().some(row => row.includes(':planningItems:')),
    'the kept partition holds the Deleted root and search row before the purge',
  );
  assert.ok(
    inKept().some(row => row.includes(':planningItems:payload:')) &&
      [...s.tables.projectPlanningRecords.values()].some(
        row =>
          row.generationId === kept &&
          row.collection === 'planningItems' &&
          row.key === itemId &&
          JSON.parse(row.value).payloadKey &&
          row.value.includes(SECRET),
      ),
    'the large Deleted root keeps its body in payload chunks and names a file path in its header',
  );
  const operationId = randomUUID();
  await assert.rejects(executor(s, 20).run(itemId, operationId), /executor stopped/);
  const done = await executor(s).run(itemId, operationId);
  assert.equal(typeof done.purgedAt, 'number');
  assert.ok(done.rows > 32, 'the journal and events steps take more than one page');
  assert.deepEqual(secretRows(s), [], 'no partition holds the words');
  assert.deepEqual(done.decisions, [], 'a finished purge keeps no decision list on the project');
});

test('a purge refuses an Item with more than 1000 Work rows and writes nothing', async t => {
  const { s, itemId } = await deletedItem(t);
  let revision = 10_000;
  for (let n = 0; n < 1000; n++) {
    const command = {
      action: 'comment-planning-item',
      operationId: randomUUID(),
      itemId,
      authorLabel: '',
      text: 'x',
    };
    await s.ctx.db.insert('projectWorkEvents', {
      projectId: s.projectId,
      operationId: command.operationId,
      request: metadataRequest(command),
      previousRevision: revision,
      revision: ++revision,
      actor: 'owner',
      at: '2026-11-20T00:00:00.000Z',
      command: JSON.stringify(command),
    });
  }
  const before = s.tables.projectWorkEvents.size;
  await assert.rejects(executor(s).run(itemId, randomUUID()), code('BAD_ARGUMENT'));
  assert.equal(s.tables.projectWorkEvents.size, before, 'no purge row');
  assert.equal(s.tables.hostedProjects.get(s.projectId).itemPurges, undefined, 'no progress entry');
});

test('review 2026-11-20 finding 2: a project with more aliases than one purge can read is refused with nothing written, never half-listed', async t => {
  const { s, itemId } = await deletedItem(t);
  const { PURGE_ALIAS_LIMIT } = modules.projectPlanningPurgeSelect;
  for (let n = 0; n < PURGE_ALIAS_LIMIT; n++) addAlias(s, randomUUID());
  addAlias(s, itemId);
  const before = s.tables.projectWorkEvents.size;
  await assert.rejects(executor(s).run(itemId, randomUUID()), code('BAD_ARGUMENT'));
  assert.equal(s.tables.projectWorkEvents.size, before, 'no purge row');
  assert.equal(s.tables.hostedProjects.get(s.projectId).itemPurges, undefined, 'no progress entry');
});

test('review 2026-11-20 (third) finding 1: an Item in the base checkpoint is refused with nothing written, since a rebuild reads the stored archive again', async t => {
  const itemId = randomUUID();
  const s = await setup(t, true, async (_root, local) => {
    await local.dispatch(
      {
        action: 'put-planning-item',
        operationId: randomUUID(),
        itemId,
        expectedVersion: 0,
        kind: 'issue',
        title: `Base ${SECRET}`,
        body: '',
        status: 'open',
        intentIds: [],
      },
      local.status().revision,
    );
  });
  const current = (await s.read()).data.planningItems.filter(item => item.id === itemId).at(-1);
  await s.send({
    action: 'put-planning-item',
    operationId: randomUUID(),
    itemId,
    expectedVersion: current.version,
    status: 'deleted',
  });
  const before = s.tables.projectWorkEvents.size;
  await assert.rejects(executor(s).run(itemId, randomUUID()), /base checkpoint/);
  assert.equal(s.tables.projectWorkEvents.size, before, 'no purge row');
  assert.equal(s.tables.hostedProjects.get(s.projectId).itemPurges, undefined, 'no progress entry');
});

test('review 2026-11-20 (fourth): an Item a record-detail catalog holds (a second stored base) is refused, and a catalog cut during the purge keeps it from finishing', async t => {
  const { s, itemId } = await deletedItem(t);
  const project = s.tables.hostedProjects.get(s.projectId);
  const catalog = revision => ({
    operationId: randomUUID(),
    backupId: project.work.backupId,
    revision,
    root: { key: 'catalog', sha256: 'a'.repeat(64), size: 1 },
  });
  project.work = { ...project.work, recordDetails: catalog(project.revision ?? 1_000_000) };
  const before = s.tables.projectWorkEvents.size;
  await assert.rejects(executor(s).run(itemId, randomUUID()), /base checkpoint/);
  assert.equal(s.tables.projectWorkEvents.size, before, 'no purge row');
  // A purge already past its first step does not finish once a catalog covers the Item.
  delete project.work.recordDetails;
  const operationId = randomUUID();
  await assert.rejects(executor(s, 1).run(itemId, operationId), /executor stopped/);
  project.work = { ...project.work, recordDetails: catalog(1_000_000) };
  await assert.rejects(executor(s).run(itemId, operationId), /base checkpoint/);
  assert.equal(
    s.tables.hostedProjects.get(s.projectId).itemPurges[0].purgedAt,
    undefined,
    'never reported done',
  );
});

test('review 2026-11-20 (fifth): an Item whose Intent row is in the stored base, with its first put after it, is refused', async t => {
  const { s, itemId } = await deletedItem(t);
  const project = s.tables.hostedProjects.get(s.projectId);
  const intentRow = [...s.tables.projectWorkEvents.values()].find(row => row.operationId === itemId);
  // The base reaches the Intent row (and no further): the put came after it.
  s.tables.projectWorkGenerations.get(project.work.generationId).initialRevision = intentRow.revision;
  const before = s.tables.projectWorkEvents.size;
  await assert.rejects(executor(s).run(itemId, randomUUID()), /base checkpoint/);
  assert.equal(s.tables.projectWorkEvents.size, before, 'no purge row');
});

test('the executor refuses an Item that is not Deleted', async t => {
  const s = await setup(t);
  const open = s.item({ title: `Open ${SECRET}` });
  await s.send(open);
  await assert.rejects(executor(s).run(open.itemId, randomUUID()), code('BAD_ARGUMENT'));
  assert.ok(secretRows(s).length > 0);
});

test('purge cost budget: one redaction call per step page, one check query per step page, two selection pages', async t => {
  const { s, itemId } = await deletedItem(t);
  const run = executor(s);
  await run.run(itemId, randomUUID());
  // Fewer than 32 rows and one record partition: each step is one page, except the stale-payload step, which pages
  // its four targets (root, search row, Initiative, Intent), and the heads step, which pages comment and lifecycle
  // heads. Plus begin and finish.
  const pages = purgeSteps.length + 4;
  assert.equal(run.calls.mutation, pages + 2, 'redaction pages, begin and finish');
  // status (twice), preflight, one selection page per journal table, one check page per step page, final status.
  assert.equal(run.calls.query, 2 + 1 + 2 + pages + 1, 'selection, check and status reads');
  assert.ok(workRecordRows(s.tables).length > 0);
});

test('records mode (work store primary): a purge of an Item with an alias-written comment leaves the words in no store', async t => {
  const { s, itemId, keep, alias } = await deletedItem(t, { records: true, intentBorn: false });
  assert.equal(s.tables.hostedProjects.get(s.projectId).workStore, 'records');
  const stored = [...s.tables.projectHostedRecords.values()].filter(row => row.kind === 'comment');
  assert.ok(stored.length >= 3, 'the store holds the comments and the note');
  // Every Issue is also an Intent, and the store keeps that Intent's versions (the Item's Intent copy).
  assert.ok(storeIntents(s, itemId).length > 1, 'the store keeps several Intent versions');
  const done = await executor(s).run(itemId, randomUUID());
  assert.equal(typeof done.purgedAt, 'number');
  assert.deepEqual(done.ids, [itemId, alias].sort(), 'the Item id and its alias');
  assert.ok(done.rows >= 7, 'puts, comments, the alias comment, note and the Deleted put are listed');
  assert.deepEqual(secretRows(s), [], 'no table holds the purged words, the alias-written comment included');
  // The store readers return the tombstone and no words; the kept Item reads as before.
  const page = (collection, extra = {}) =>
    workIndex.records._handler(s.ctx, {
      projectId: s.projectId,
      collection,
      paginationOpts: { cursor: null, numItems: 100 },
      ...extra,
    });
  // A per-Item read answers that the Item was deleted permanently, or returns no words.
  const perItem = extra =>
    page(extra.collection, extra).then(
      result => result,
      error => (code('PLANNING_ITEM_PURGED')(error) ? 'purged' : Promise.reject(error)),
    );
  const reads = [
    await page('planningItems'),
    await perItem({ collection: 'planningVersions', parentId: itemId }),
    await perItem({ collection: 'planningComments', parentId: itemId }),
    await perItem({ collection: 'notes', parentId: itemId }),
  ];
  assert.equal(JSON.stringify(reads).includes(SECRET), false);
  assert.ok(reads[0].page.some(row => row.id === keep.itemId));
});

const journalRevision = s =>
  Math.max(
    ...[...s.tables.projectWorkEvents.values(), ...s.tables.projectHostedRecordBodies.values()].map(
      row => row.revision ?? 0,
    ),
  );
/** The work store's versions of one Intent, oldest first. */
const storeIntents = (s, key) =>
  [...s.tables.projectHostedRecords.values()]
    .filter(row => row.kind === 'intent' && row.key === key)
    .sort((a, b) => a.version - b.version);
const readIntent = (s, key, version) =>
  hostedRecords.readHostedRecord(s.ctx, {
    projectId: s.projectId,
    actor: 'owner',
    kind: 'intent',
    key,
    version,
  });

/** A Lane pins the Item's Intent (a hosted version, as projectHostedStart writes it) and, once it finished, a later
 * start continues the Item on its successor Intent, which copies the outcome. */
async function pinAndContinue(s, itemId) {
  const head = (await readIntent(s, itemId)) ?? assert.fail('the store keeps the Intent');
  const stored = JSON.parse(head.value);
  const write = (record, expectedVersion) =>
    hostedRecords.writeHostedRecord(s.ctx, {
      projectId: s.projectId,
      actor: 'owner',
      authorityEpoch: 1,
      record,
      expectedVersion,
    });
  const base = { head: 'b'.repeat(64), receiptId: 'receipt-1' };
  await write({ ...stored, version: head.version + 1, base, status: 'active' }, head.version);
  await write({ ...stored, version: head.version + 2, base, status: 'completed' }, head.version + 1);
  const successor = successorIntentId(itemId);
  await write(
    {
      kind: 'intent',
      id: successor,
      version: 0,
      at: stored.at,
      outcome: `Successor ${SECRET}`,
      constraints: `Successor constraints ${SECRET}`,
      creatorAccountId: 'owner',
      assigneeAccountIds: [],
      base,
      status: 'active',
    },
    null,
  );
  return successor;
}

test('purge Lane 3, records mode: an Intent-born Item (Lane-pinned, continued on a successor, with a handoff) ends with a Deleted Item Intent version, every older version purged, and its words in no table', async t => {
  const { s, itemId } = await deletedItem(t, { records: true });
  const successor = await pinAndContinue(s, itemId);
  // A legacy handoff note: the Intent header lists its summary and the note keeps the handoff's free text.
  const project = s.tables.hostedProjects.get(s.projectId);
  for (const row of workRecordRows(s.tables))
    if (
      row.generationId === project.work.generationId &&
      row.collection === 'intents' &&
      row.key === itemId
    ) {
      const value = JSON.parse(row.value);
      value.handoffs = [{ laneId: randomUUID(), summary: `Handoff ${SECRET}` }];
      row.value = JSON.stringify(value);
    } else if (row.collection === 'notes' && row.parent === itemId) {
      const value = JSON.parse(row.value);
      value.handoff = { laneId: randomUUID(), summary: `Handoff note ${SECRET}` };
      row.value = JSON.stringify(value);
    }
  // The Lane on the Intent keeps the outcome on its overlap row (review finding 2).
  const laneId = randomUUID();
  await s.ctx.db.insert('projectHostedRecordHeads', {
    projectId: s.projectId,
    kind: 'lane',
    key: laneId,
    parent: itemId,
    status: 'completed',
    version: 0,
    recordId: 'lane-record',
  });
  await s.ctx.db.insert('projectHostedOverlapLanes', {
    projectId: s.projectId,
    laneId,
    intentId: itemId,
    actor: 'owner',
    intent: `Title ${SECRET}`,
    head: 'h',
    baseHead: 'h',
    baseReceiptId: 'receipt-1',
    baseSequence: null,
    recordVersion: 0,
    open: false,
    changes: '[]',
    complete: true,
  });
  const before = storeIntents(s, itemId);
  assert.ok(before.length >= 3 && storeIntents(s, successor).length === 1);
  const done = await executor(s).run(itemId, randomUUID());
  assert.equal(
    typeof done.purgedAt,
    'number',
    'marked done: nothing blocks an Item whose Intent is in the store',
  );
  assert.deepEqual(
    secretRows(s),
    [],
    'no table holds the words: Intent versions, successor and handoffs included',
  );
  for (const key of [itemId, successor]) {
    const versions = storeIntents(s, key),
      head = versions.at(-1);
    // The Intent copy reads 'Deleted Item' in a new version (its head), and keeps its status and base.
    const current = await readIntent(s, key);
    assert.equal(current.version, head.version);
    const value = JSON.parse(current.value);
    assert.deepEqual([value.outcome, value.constraints], ['Deleted Item', '']);
    assert.equal(value.base.receiptId, 'receipt-1', 'a Lane-pinned Intent stays pinned');
    // Every older version is purged: a read by version answers that the Item was deleted permanently.
    for (const old of versions.slice(0, -1)) {
      assert.equal(old.purged, done.operationId);
      await assert.rejects(readIntent(s, key, old.version), error => {
        assert.equal(error.code ?? error.data?.code, 'PLANNING_ITEM_PURGED');
        assert.equal(error.recovery.itemId, itemId, 'a successor Intent names the purged Item');
        return true;
      });
    }
  }
  assert.equal(
    storeIntents(s, itemId).length,
    before.length + 1,
    'one Deleted Item version, nothing removed',
  );
  // Running the purge again changes nothing: the Deleted Item version is a fixed point.
  const rows = s.tables.projectHostedRecords.size;
  await executor(s).run(itemId, done.operationId);
  assert.equal(s.tables.projectHostedRecords.size, rows);
});

test('review (Lane 3) finding 3: a successor id that names an Issue of its own ends the Intent chain; that Issue keeps its words', async t => {
  const { s, itemId } = await deletedItem(t, { records: true });
  const other = successorIntentId(itemId);
  // The alias lives in the index only, so this write passes the journal's revision (as deletedItem does).
  await s.send(s.item({ itemId: other, title: 'Unrelated Issue' }), journalRevision(s));
  const kept = storeIntents(s, other);
  assert.ok(kept.length > 0, 'the unrelated Issue has its own Intent versions');
  const done = await executor(s).run(itemId, randomUUID());
  assert.equal(typeof done.purgedAt, 'number');
  assert.ok(storeIntents(s, other).every(row => row.purged === undefined));
  assert.equal(JSON.parse((await readIntent(s, other)).value).outcome, 'Unrelated Issue');
});

test('review (Lane 3) finding 4: a note reaching the Intent after the first step keeps the purge from finishing', async t => {
  const { s, itemId } = await deletedItem(t);
  const operationId = randomUUID();
  await assert.rejects(executor(s, 1).run(itemId, operationId), /executor stopped/);
  await s.send({ action: 'note', intentId: itemId, text: `Late note ${SECRET}`, kind: 'comment' });
  await assert.rejects(executor(s).run(itemId, operationId), /after its purge began/);
  assert.equal(
    s.tables.hostedProjects.get(s.projectId).itemPurges[0].purgedAt,
    undefined,
    'never reported done',
  );
});

test('review (Lane 3) finding 5: a body another live record shares keeps its bytes; the purged version still reads purged', async t => {
  const { s, itemId } = await deletedItem(t, { records: true });
  const [old] = storeIntents(s, itemId);
  const value = s.tables.projectHostedRecordBodies.get(old.bodyId).value;
  const live = await s.ctx.db.insert('projectHostedRecords', {
    ...old,
    _id: undefined,
    _creationTime: undefined,
    key: randomUUID(),
  });
  const done = await executor(s).run(itemId, randomUUID());
  assert.equal(typeof done.purgedAt, 'number');
  assert.equal(s.tables.projectHostedRecords.get(old._id).purged, done.operationId);
  assert.equal(
    s.tables.projectHostedRecordBodies.get(old.bodyId).value,
    value,
    'the live owner can still verify its body',
  );
  assert.equal(s.tables.projectHostedRecords.get(live).purged, undefined);
});

test('purge Lane 3: a work-store lifecycle version (a status move, with its reason) is purged and its head keeps the purged form', async t => {
  const { s, itemId } = await deletedItem(t, { records: true });
  const lifecycle = () =>
    [...s.tables.projectHostedRecords.values()].filter(
      row => row.kind === 'lifecycle' && row.parent === itemId,
    );
  // A moved status records a lifecycle entry with the put's reason (a Deleted put moves the Item too).
  if (!lifecycle().length) {
    const { workStoreRecord } = await import('../dist/work-store-records.js');
    const { hostedRecordValue } = await import('../dist/hosted-records.js');
    const { storeVersion } = workStore;
    await storeVersion(
      s.ctx,
      s.projectId,
      hostedRecordValue(
        workStoreRecord('lifecycle', {
          intentId: itemId,
          index: 0,
          from: 'open',
          to: 'deleted',
          at: '2026-11-20T00:00:00.000Z',
          reason: `Why ${SECRET}`,
        }),
      ),
    );
  }
  assert.ok(lifecycle().length > 0 && secretRows(s).some(row => row.startsWith('projectHostedRecord')));
  const done = await executor(s).run(itemId, randomUUID());
  assert.equal(typeof done.purgedAt, 'number');
  assert.ok(lifecycle().every(row => row.purged === done.operationId));
  assert.deepEqual(secretRows(s), []);
});

test('purge Lane 3: a project with hosted display snapshots (copies of record bodies) is refused with nothing written, and one made during a purge keeps it from finishing', async t => {
  const { s, itemId } = await deletedItem(t);
  const display = () =>
    s.ctx.db.insert('projectHostedDisplayRecords', {
      projectId: s.projectId,
      snapshotId: 'snapshot',
      kind: 'intent',
      key: itemId,
      version: 0,
      parent: 'owner',
      status: 'active',
      value: `{"outcome":"${SECRET}"}`,
    });
  const id = await display();
  const before = s.tables.projectWorkEvents.size;
  await assert.rejects(executor(s).run(itemId, randomUUID()), /display snapshots/);
  assert.equal(s.tables.projectWorkEvents.size, before, 'no purge row');
  s.tables.projectHostedDisplayRecords.delete(id);
  const operationId = randomUUID();
  await assert.rejects(executor(s, 1).run(itemId, operationId), /executor stopped/);
  await display();
  await assert.rejects(executor(s).run(itemId, operationId), /display snapshots/);
  assert.equal(
    s.tables.hostedProjects.get(s.projectId).itemPurges[0].purgedAt,
    undefined,
    'never reported done',
  );
});

test('review r1: a put linking large Intents through parents and relations hydrates them in one call and never repeats an empty key', async () => {
  const large = Array.from({ length: 5 }, () => randomUUID());
  const store = new Map();
  for (const id of large) {
    const history = randomUUID();
    const intent = { id, title: 'Linked', status: 'active', historyRefs: [{ itemId: history, version: 1 }] };
    // A large Intent: its header names a payload; the history refs are only in the payload.
    const header = { id, status: 'active', payloadKey: `p-${id}`, payloadParts: 1 };
    store.set(`intents\n${id}`, { collection: 'intents', key: id, value: JSON.stringify(header) });
    store.set(`intents:payload\np-${id}:0`, {
      collection: 'intents:payload',
      key: `p-${id}:0`,
      position: 0,
      value: JSON.stringify(intent),
    });
    store.set(`planningItems\n${history}`, { collection: 'planningItems', key: history, value: '{}' });
  }
  const plain = randomUUID();
  const asked = [];
  const lookup = async keys => {
    asked.push(keys.map(({ collection, key }) => `${collection}\n${key}`));
    return keys.map(({ collection, key }) => store.get(`${collection}\n${key}`) ?? null);
  };
  const put = {
    action: 'put-planning-item',
    operationId: randomUUID(),
    itemId: randomUUID(),
    expectedVersion: 0,
    kind: 'issue',
    title: 'New',
    parentId: plain,
    relations: large.map(id => ({ id, kind: 'related' })),
  };
  const rows = [];
  await commandPlanningRows(rows, put, lookup);
  const keys = asked.flat();
  assert.equal(new Set(keys).size, keys.length, 'no key is looked up twice, also when it came back empty');
  // Aliases and Intents of the named ids; every payload part at once; the linked history Items.
  assert.equal(asked.length, 3, `lookup calls: ${asked.length}`);
  for (const id of large)
    assert.ok(
      rows.some(row => row?.collection === 'intents:attributes' && row.key === id),
      'hydrated',
    );
});

function storage(t) {
  const objects = new Map(),
    requests = [];
  let failDeletion = false,
    losePut = false;
  const keys = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
  const prior = new Map(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = 'synthetic';
  t.after(() => {
    for (const [key, value] of prior)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = new URL(url).pathname;
    if (!path.includes('/journal-segments/')) return original(url, init);
    const key = path.split('/').at(-1);
    const method = init?.method ?? 'GET';
    requests.push({ key, method });
    if (method === 'PUT') {
      objects.set(key, Buffer.from(init.body));
      if (losePut) {
        losePut = false;
        throw new TypeError('Synthetic lost successful PUT response');
      }
      return new Response(null, { status: 200 });
    }
    if (method === 'DELETE') {
      if (failDeletion) return new Response(null, { status: 403 });
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return objects.has(key) ? new Response(objects.get(key)) : new Response(null, { status: 404 });
  });
  return {
    objects,
    requests,
    refuseDeletions: value => {
      failDeletion = value;
    },
    loseNextPut: () => {
      losePut = true;
    },
  };
}

async function putSegment(s, storage, category, from, tables, { fragmented = false } = {}) {
  const segment = {
    protocol: 1,
    kind: 'forge-journal-segment',
    projectId: s.projectId,
    scope: category === 'record' ? 'records' : 'events',
    from,
    through: from,
    tables,
  };
  const texts = fragmented ? journalFragmentTexts(segment) : [journalSegmentText(segment)];
  const pointers = texts.map(text => {
    const { pointer, body } = encodeArchiveBytes(text, from, journalTablePins(JSON.parse(text).tables));
    storage.objects.set(pointer.sha256, body);
    return pointer;
  });
  const [pointer, ...parts] = pointers;
  const index = { scope: segment.scope, from, through: from, pointer, ...(parts.length ? { parts } : {}) };
  const fields = { projectId: s.projectId, scope: segment.scope, from, through: from };
  await s.ctx.db.insert('projectJournalSegments', {
    ...fields,
    key: pointer.sha256,
    category,
    value: canonicalPayload(index),
  });
  for (const part of parts)
    await s.ctx.db.insert('projectJournalSegments', {
      ...fields,
      key: part.sha256,
      category: 'fragment',
      value: canonicalPayload({ scope: segment.scope, from, through: from, pointer: part }),
    });
  return pointers.map(pin => pin.sha256);
}

async function oldIntentSegment(s, r2, itemId, options) {
  const record = [...s.tables.projectHostedRecords.values()].find(
    row =>
      row.kind === 'intent' &&
      row.key === itemId &&
      JSON.stringify(s.tables.projectHostedRecordBodies.get(row.bodyId)).includes(SECRET),
  );
  assert(record);
  const body = s.tables.projectHostedRecordBodies.get(record.bodyId);
  assert.equal(body.operationId, undefined, 'only an exclusive plain body moves with a record');
  const unrelated = options?.fragmented
    ? [
        canonicalPayload({
          _id: 'large-unrelated',
          kind: 'lane',
          projectId: s.projectId,
          inline: 'x'.repeat(230_000),
        }),
      ]
    : [];
  const keys = await putSegment(
    s,
    r2,
    'record',
    record.version,
    {
      projectHostedRecords: [canonicalPayload(record), ...unrelated],
      projectHostedRecordBodies: [canonicalPayload(body)],
    },
    options,
  );
  await s.ctx.db.patch(record._id, { inline: undefined, journalSegment: keys[0] });
  await s.ctx.db.delete(record.bodyId);
  return { keys, record };
}

test('purge rewrites only the affected archive objects, preserves original event retries, and rebuilds without fixture text', async t => {
  const { s, itemId } = await deletedItem(t, { records: true, useAlias: false });
  const r2 = storage(t);
  await workStore.setMode._handler(s.ctx, {
    projectId: s.projectId,
    mode: 'records',
    writers: ['planning', 'note'],
  });
  const revision = journalRevision(s);
  for (let offset = 0; offset < 3; offset++)
    await s.send(
      { action: 'note', intentId: itemId, text: `Note ${SECRET} ${offset}`, kind: 'comment' },
      revision + offset,
    );
  const old = await oldIntentSegment(s, r2, itemId);
  const note = structuredClone(
    [...s.tables.projectHostedRecordBodies.values()].find(row => row.command?.includes('Note ' + SECRET)),
  );
  assert(note, 'the fixture has a record-store event to relocate');
  const [eventKey] = await putSegment(s, r2, 'events', note.revision, {
    projectHostedRecordBodies: [canonicalPayload(note)],
  });
  await s.ctx.db.patch(note._id, {
    command: undefined,
    journalSegment: '1',
    journalCommand: canonicalPayload({ action: 'note' }),
  });
  for (let i = 1; i <= 18; i++)
    await putSegment(s, r2, 'record', 10_000 + i, {
      projectHostedRecords: [
        canonicalPayload({
          _id: 'unrelated-' + i,
          projectId: s.projectId,
          kind: 'lane',
          key: 'untouched-' + i,
          version: i,
          inline: 'unchanged',
        }),
      ],
    });
  const project = s.tables.hostedProjects.get(s.projectId);
  project.journalRevision = 20;
  const original = new Map(r2.objects);
  const operationId = randomUUID();
  const worker = executor(s);
  const meter = meterWorkIO(s.ctx, s.tables);
  const start = performance.now();
  let done, io;
  try {
    io = await meter.cost(async () => {
      done = await worker.run(itemId, operationId);
    });
  } finally {
    meter.restore();
  }
  assert.equal(typeof done.purgedAt, 'number');
  assert.equal(done.rows, 10, 'the purge cost fixture contains ten Work rows');
  t.diagnostic(
    JSON.stringify({
      workRows: done.rows,
      segments: original.size,
      ...worker.calls,
      ...io,
      gets: r2.requests.filter(row => row.method === 'GET').length,
      puts: r2.requests.filter(row => row.method === 'PUT').length,
      deletes: r2.requests.filter(row => row.method === 'DELETE').length,
      wallMs: Math.round(performance.now() - start),
      sampledRss: process.memoryUsage().rss,
    }),
  );
  const retired = new Set([...old.keys, eventKey]);
  assert.deepEqual(new Set(r2.requests.filter(row => row.method === 'DELETE').map(row => row.key)), retired);
  assert.equal(r2.requests.filter(row => row.method === 'PUT').length, 2);
  assert.equal(
    r2.requests.filter(row => row.method === 'GET').length,
    25,
    '20 sweep reads, one selection and four write verification reads',
  );
  for (const [key, bytes] of original)
    if (!retired.has(key))
      assert.equal(r2.objects.get(key), bytes, 'unrelated object remains byte-identical');
  assert.equal(
    [...r2.objects.values()].some(bytes => gunzipSync(bytes).includes(SECRET)),
    false,
  );
  const stored = s.tables.projectHostedRecords.get(old.record._id);
  assert.equal(stored.purged, operationId);
  await assert.rejects(hostedRecords.hostedRecordBody(s.ctx, stored), code('PLANNING_ITEM_PURGED'));
  const events = await import(moduleUrl('../convex/projectWorkEventStore.ts'));
  await assert.rejects(
    events.findWorkEvent(s.ctx, s.projectId, note.operationId, { command: note.command }),
    code('PLANNING_ITEM_PURGED'),
  );
  await ensure._handler(worker.ctx, { projectId: s.projectId, rebuild: true });
  const journal = await actions.exportJournal._handler(worker.ctx, { projectId: s.projectId, purgedRows: 2 });
  assert.equal(JSON.stringify(journal).includes(SECRET), false);
  assert.deepEqual(secretRows(s), []);
});

test('an interrupted purge retires the original R2 object on retry without uploading it again', async t => {
  const { s, itemId } = await deletedItem(t, { records: true, useAlias: false });
  const r2 = storage(t);
  const old = await oldIntentSegment(s, r2, itemId, { fragmented: true });
  assert.ok(old.keys.length > 1, 'the original uses several physical objects');
  s.tables.hostedProjects.get(s.projectId).journalRevision = 1;
  const operationId = randomUUID();
  r2.refuseDeletions(true);
  await assert.rejects(executor(s).run(itemId, operationId), code('R2_DELETE_FAILED'));
  const partial = s.tables.hostedProjects.get(s.projectId).itemPurges[0];
  assert.equal(partial.purgedAt, undefined);
  assert.ok(partial.segmentSweep.pending.retire.length);
  assert.ok(r2.objects.has(old.keys[0]), 'the original still exists after the failed retirement');
  const puts = r2.requests.filter(row => row.method === 'PUT').length;
  r2.refuseDeletions(false);
  const worker = executor(s);
  const done = await worker.run(itemId, operationId);
  assert.equal(typeof done.purgedAt, 'number');
  assert.equal(r2.requests.filter(row => row.method === 'PUT').length, puts);
  assert.equal(
    [...r2.objects.values()].some(bytes => gunzipSync(bytes).includes(SECRET)),
    false,
  );
  await ensure._handler(worker.ctx, { projectId: s.projectId, rebuild: true });
  assert.deepEqual(secretRows(s), []);
});

test('purge scrubs lifecycle plans and child events and fences an earlier recovery selection', async t => {
  const { s, itemId } = await deletedItem(t, { records: true, intentBorn: false });
  const head = await hostedRecords.recordHead(s.ctx, s.projectId, 'intent', itemId);
  const lifecycle = await import(moduleUrl('../convex/projectHostedLifecycle.ts'));
  const operationId = randomUUID();
  const request = canonicalPayload({
    operationId,
    authorityEpoch: 1,
    action: 'abandon',
    reason: 'Abandon ' + SECRET,
    target: { kind: 'intent', intentId: itemId, version: head.version },
  });
  const input = { projectId: s.projectId, request };
  const receipt = await lifecycle.transition._handler(s.ctx, input);
  const plan = [...s.tables.projectHostedLifecyclePlans.values()].find(
    row => row.operationId === operationId,
  );
  const [event] = s.tables.projectHostedLifecycleEvents.values();
  assert.ok(JSON.stringify(plan).includes(SECRET) && JSON.stringify(event).includes(SECRET));
  for (let index = 0; index < 40; index++)
    await s.ctx.db.insert('projectHostedLifecycleEvents', {
      projectId: s.projectId,
      planId: plan._id,
      key: randomUUID(),
      kind: 'lane',
      index,
      value: event.value,
    });
  const terminal = [...s.tables.projectHostedOperations.values()].find(
    row => row.operationId === operationId,
  ).value;
  const purgeId = randomUUID();
  const stopped = executor(s, Infinity, (module, name, args) => {
    if (module === 'projectPlanningPurge' && name === 'redact' && args.step === 'lifecyclePlans')
      throw new Error('executor stopped');
  });
  await assert.rejects(stopped.run(itemId, purgeId), /executor stopped/);
  assert.equal(s.tables.hostedProjects.get(s.projectId).itemPurges[0].purgedAt, undefined);

  const main = {
    schema: 2,
    projectId: s.projectId,
    snapshotId: 'main-snapshot',
    sourceRevision: 1,
    authority: { mode: 'server', epoch: 1 },
    channel: 'main',
    head: 'b'.repeat(64),
    receipt: { id: 'main-receipt', kind: 'server', previousHead: null, previousReceiptId: null },
  };
  await s.ctx.db.insert('projectHostedChannels', {
    projectId: s.projectId,
    operationId: randomUUID(),
    name: 'main',
    selection: canonicalPayload(main),
  });
  const recovery = await import(moduleUrl('../convex/projectRecovery.ts'));
  const hostedRecovery = await import(moduleUrl('../convex/projectRecoveryHosted.ts'));
  const prepare = async () =>
    JSON.parse(
      await recovery.prepare._handler(s.ctx, {
        projectId: s.projectId,
        operationId: randomUUID(),
      }),
    ).selection;
  const oldSelection = await prepare();
  const page = selection =>
    hostedRecovery.page._handler(s.ctx, {
      projectId: s.projectId,
      selection: canonicalPayload(selection),
      table: 'projectHostedLifecyclePlans',
      cursor: null,
    });
  assert.ok(
    (await page(oldSelection)).includes(SECRET),
    'recovery had already collected the original author reason',
  );
  assert.equal(typeof (await executor(s).run(itemId, purgeId)).purgedAt, 'number');
  await assert.rejects(page(oldSelection), code('WORK_STALE'));
  const fresh = await prepare();
  assert.equal(fresh.revision, oldSelection.revision);
  assert.deepEqual(fresh.hostedMain, main);
  const restored = JSON.parse(await page(fresh));
  assert.ok(restored.done && !JSON.stringify(restored.rows).includes(SECRET));
  assert.deepEqual(secretRows(s), []);
  assert.equal(await lifecycle.transition._handler(s.ctx, input), receipt);
  assert.equal(
    [...s.tables.projectHostedOperations.values()].find(row => row.operationId === operationId).value,
    terminal,
  );
});

test('purge recovers an expired staged Intent upload even when packing has been disabled', async t => {
  const { s, itemId } = await deletedItem(t, { records: true, useAlias: false });
  const r2 = storage(t);
  const previous = process.env.FORGE_JOURNAL_SEGMENTS;
  process.env.FORGE_JOURNAL_SEGMENTS = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_JOURNAL_SEGMENTS;
    else process.env.FORGE_JOURNAL_SEGMENTS = previous;
  });
  const [old] = storeIntents(s, itemId);
  await s.ctx.db.patch(old._id, { journalReadyAt: 1 });
  const capture = JSON.parse(
    await modules.projectJournalCapture.page._handler(s.ctx, {
      projectId: s.projectId,
      operationId: randomUUID(),
      claim: randomUUID(),
      phase: 0,
    }),
  );
  assert.deepEqual(capture.pending.intentKeys, [itemId]);
  const { encodePlannedJournal } = await import(moduleUrl('../convex/projectJournalArchivePlan.ts'));
  for (const text of capture.texts) {
    const { body, pointer } = encodePlannedJournal(text, JSON.parse(text));
    assert.ok(capture.pending.planned.includes(pointer.sha256));
    r2.objects.set(pointer.sha256, body);
  }
  assert.ok([...r2.objects.values()].some(bytes => gunzipSync(bytes).includes(SECRET)));
  const purgeId = randomUUID();
  await assert.rejects(executor(s).run(itemId, purgeId), /archiving one of this Item/);
  assert.equal(s.tables.hostedProjects.get(s.projectId).itemPurges, undefined);

  // The writer died after its PUT. Disabling the writer still permits purge to retire the
  // unpublished objects of that exact expired capture.
  delete process.env.FORGE_JOURNAL_SEGMENTS;
  for (const row of s.tables.projectJournalReceipts.values()) {
    const envelope = JSON.parse(row.envelope);
    if (envelope.pending) envelope.pending.until = 0;
    else if (row.operationId === 'journal-pending') envelope.until = 0;
    else continue;
    await s.ctx.db.patch(row._id, { envelope: canonicalPayload(envelope) });
  }
  const done = await executor(s).run(itemId, purgeId);
  assert.equal(typeof done.purgedAt, 'number');
  assert.ok(capture.pending.planned.every(hash => !r2.objects.has(hash)));
  assert.ok(
    r2.requests.every(request => request.method === 'DELETE'),
    'cleanup starts no new packing',
  );
  assert.deepEqual(secretRows(s), []);
});

test('a lost fragment PUT and codec change leave no hidden bytes from a later-purged Item', async t => {
  const { s, itemId, keep } = await deletedItem(t, { records: true, useAlias: false });
  const r2 = storage(t);
  const otherText = 'a different synthetic Item rationale';
  await s.send(s.item({ itemId: keep.itemId, expectedVersion: 1, title: otherText }), journalRevision(s));
  await s.send(s.item({ itemId: keep.itemId, expectedVersion: 2, status: 'deleted' }), journalRevision(s));
  const versions = [
    [itemId, SECRET],
    [keep.itemId, otherText],
  ].map(([key, text]) =>
    storeIntents(s, key).find(row =>
      s.tables.projectHostedRecordBodies.get(row.bodyId)?.value.includes(text),
    ),
  );
  assert.ok(versions.every(Boolean));
  const keys = await putSegment(
    s,
    r2,
    'record',
    versions[0].version,
    {
      projectHostedRecords: [
        ...versions.map(row => canonicalPayload(row)),
        canonicalPayload({
          _id: 'large-unrelated',
          kind: 'lane',
          projectId: s.projectId,
          inline: 'x'.repeat(550_000),
        }),
      ],
      projectHostedRecordBodies: versions.map(row =>
        canonicalPayload(s.tables.projectHostedRecordBodies.get(row.bodyId)),
      ),
    },
    { fragmented: true },
  );
  for (const row of versions) {
    await s.ctx.db.patch(row._id, { inline: undefined, journalSegment: keys[0] });
    await s.ctx.db.delete(row.bodyId);
  }
  s.tables.hostedProjects.get(s.projectId).journalRevision = 1;
  const operationId = randomUUID();
  r2.loseNextPut();
  await assert.rejects(executor(s).run(itemId, operationId));
  const project = s.tables.hostedProjects.get(s.projectId);
  const pending = project.itemPurges[0].segmentSweep.pending;
  const [replacement] = pending.planned;
  assert.ok(
    pending.planned.length > 1 && r2.objects.has(replacement),
    'the lost response followed the first fragment',
  );
  assert.ok(r2.objects.has(keys[0]), 'the original is still authoritative');

  const former = gzipSync(gunzipSync(r2.objects.get(replacement)), { level: 1 });
  const formerKey = digest(former);
  assert.notEqual(formerKey, replacement);
  pending.planned[0] = formerKey;
  r2.objects.set(formerKey, former);
  r2.objects.delete(replacement);
  assert.equal(typeof (await executor(s).run(itemId, operationId)).purgedAt, 'number');
  assert.ok(!r2.objects.has(formerKey));
  assert.equal(typeof (await executor(s).run(keep.itemId, randomUUID())).purgedAt, 'number');
  const { getJournalSegment } = await import(moduleUrl('../convex/projectJournalObject.ts'));
  for (const row of s.tables.projectJournalSegments.values()) {
    if (row.category === 'fragment') continue;
    const segment = JSON.stringify(await getJournalSegment(s.projectId, JSON.parse(row.value)));
    assert.ok(!segment.includes(SECRET) && !segment.includes(otherText));
  }
  assert.deepEqual(secretRows(s), []);
});

async function archiveOneNote(s, r2, itemId) {
  await workStore.setMode._handler(s.ctx, {
    projectId: s.projectId,
    mode: 'records',
    writers: ['planning', 'note'],
  });
  await s.send(
    { action: 'note', kind: 'comment', intentId: itemId, text: `Archived ${SECRET}` },
    journalRevision(s),
  );
  const row = structuredClone(
    [...s.tables.projectHostedRecordBodies.values()].find(value =>
      value.command?.includes(`Archived ${SECRET}`),
    ),
  );
  assert.ok(row);
  const [key] = await putSegment(s, r2, 'events', row.revision, {
    projectHostedRecordBodies: [canonicalPayload(row)],
  });
  await s.ctx.db.patch(row._id, {
    command: undefined,
    journalSegment: '1',
    journalCommand: canonicalPayload({ action: 'note' }),
  });
  return key;
}

test('journal export refuses old author text collected before purge completion', async t => {
  const { s, itemId } = await deletedItem(t, { records: true, useAlias: false });
  const r2 = storage(t);
  await archiveOneNote(s, r2, itemId);
  s.tables.hostedProjects.get(s.projectId).journalRevision = 1;
  const operationId = randomUUID();
  await assert.rejects(executor(s, 0).run(itemId, operationId), /executor stopped/);
  const { ctx } = executor(s);
  let oldBytes = false,
    projectReads = 0;
  const exporting = {
    ...ctx,
    async runQuery(ref, args) {
      const name = getFunctionName(ref);
      if (name === 'projectWork:get' && ++projectReads === 2) {
        assert.ok(oldBytes, 'the export already collected the original archived command');
        assert.equal(typeof (await executor(s).run(itemId, operationId)).purgedAt, 'number');
      }
      const result = await ctx.runQuery(ref, args);
      if (name === 'projectJournalRead:read' && JSON.stringify(result).includes(SECRET)) oldBytes = true;
      return result;
    },
  };
  await assert.rejects(
    actions.exportJournal._handler(exporting, { projectId: s.projectId, purgedRows: 2 }),
    code('WORK_CHANGED_DURING_PUSH'),
  );
  const current = await actions.exportJournal._handler(ctx, { projectId: s.projectId, purgedRows: 2 });
  assert.equal(current.includes(SECRET), false);
});

test('an interrupted archive selection resumes from its saved page and consumes the cursor with the tombstone', async t => {
  const { s, itemId } = await deletedItem(t, { records: true, useAlias: false });
  const r2 = storage(t);
  for (let i = 0; i < 16; i++)
    await putSegment(s, r2, 'events', 20_000 + i, {
      projectHostedRecordBodies: [
        canonicalPayload({
          _id: 'unrelated-event-' + i,
          projectId: s.projectId,
          value: '',
        }),
      ],
    });
  const eventKey = await archiveOneNote(s, r2, itemId);
  s.tables.hostedProjects.get(s.projectId).journalRevision = 17;
  const operationId = randomUUID();
  let pages = 0;
  const stopped = executor(s, Infinity, (module, name) => {
    if (module === 'projectPlanningPurgeSegments' && name === 'page' && ++pages === 2)
      throw new Error('selection stopped after one page');
  });
  await assert.rejects(stopped.run(itemId, operationId), /selection stopped/);
  assert.equal(r2.requests.filter(row => row.method === 'GET').length, 16);
  assert.equal(s.tables.hostedProjects.get(s.projectId).itemPurges, undefined);
  r2.requests.length = 0;
  const worker = executor(s, Infinity, (module, name) => {
    if (module === 'projectPlanningPurge' && name === 'begin')
      assert.deepEqual(r2.requests, [{ key: eventKey, method: 'GET' }]);
  });
  const done = await worker.run(itemId, operationId);
  assert.equal(typeof done.purgedAt, 'number');
  assert.equal(done.rows, 8);
  assert.ok(
    [...s.tables.projectJournalReceipts.values()].every(
      row => row.operationId !== 'purge-selection:' + operationId,
    ),
  );
});
