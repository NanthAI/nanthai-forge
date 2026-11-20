// SPDX-License-Identifier: Apache-2.0
// Purge executor (Item 4c9e961e, purge Lanes 2 and 3): selection, the atomic first step, redaction of every store
// (the work store's Intent versions, lifecycle versions and handoff summaries included), the completeness check before
// purgedAt, resume after a crash and after an index rebuild, and the row limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { setup, actions } from './hosted-planning-fixture.mjs';
import { workRecordRows } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const SECRET = 'quokka-executor-fixture';
const code = expected => error => (error.data?.code ?? error.code) === expected;
const modules = {
  projectPlanningPurge: await import(moduleUrl('../convex/projectPlanningPurge.ts')),
  projectPlanningPurgeSelect: await import(moduleUrl('../convex/projectPlanningPurgeSelect.ts')),
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
function executor(s, crash = Infinity) {
  const calls = { query: 0, mutation: 0, redact: 0 };
  const route = kind => {
    const original = s.ctx[kind];
    return (ref, args) => {
      const [module, name] = getFunctionName(ref).split(':');
      const target = modules[module]?.[name];
      if (!target) return original(ref, args);
      calls[kind === 'runQuery' ? 'query' : 'mutation']++;
      if (name === 'redact' && ++calls.redact > crash) throw new Error('executor stopped');
      return target._handler(s.ctx, args);
    };
  };
  const ctx = { ...s.ctx, runQuery: route('runQuery'), runMutation: route('runMutation') };
  return {
    calls,
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
async function deletedItem(t, { records = false, intentBorn = true, large = false } = {}) {
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
    alias = addAlias(s, itemId);
    await storeMode(s, 'records');
    await s.send(keep);
    // The alias lives in the index only (a real one comes from the base checkpoint, which a full read replays from),
    // so the last two writes pass their revision instead of reading the whole journal.
    const revision = (await s.read()).data.revision;
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
    await s.send(deleted, revision + 1);
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
      request: 'a'.repeat(64),
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
