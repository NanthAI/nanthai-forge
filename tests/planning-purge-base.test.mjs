// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item b6588425 line 2e: a whole Item whose words are in the stored base checkpoint is purged there too. The purge
// lists the Item's base rows from the Work index, the base scrub (src/work-base-scrub.ts itemScrub) rewrites every
// base record of the Item and refuses one the list missed, and the replaced objects are tombstoned, except an
// object another backup's whole Work still names (the reference check).
import { workEventRows } from './work-event-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { convexRowJson } from './convex-args.mjs';
import { moduleUrl } from './convex-module.mjs';
import { meterWorkIO } from './hosted-read-set.mjs';
import { recordBytes } from '../dist/work-exchange-records.js';
import { backupRootPin, itemScrub } from '../dist/work-base-scrub.js';
import { purgedIndexValue } from '../dist/work-planning-purge.js';
import { jsonChunks } from '../dist/json-chunks.js';
import { buildObjectRecipe, ObjectRecipeBuilder } from '../dist/object-chunks.js';
import { digest } from '../dist/hash.js';
import { successorIntentId } from '../dist/hosted-intent-chain.js';
import { upload } from './project-exchange-fixture.mjs';
import {
  SECRET,
  OTHER,
  code,
  modules,
  workLoad,
  exchangeObjectReader,
  readHosted,
  storedWords,
  tableWords,
  based,
} from './base-checkpoint-fixture.mjs';

const KEEP = 'numbat-kept-item-fixture';
for (const name of [
  'projectPlanningPurge',
  'projectPlanningPurgeSelect',
  'projectPlanningPurgeArchiveSelection',
  'projectJournalCapture',
  'projectJournalPublish',
  'projectJournalRun',
  'projectCommentPurgeBase',
])
  modules[name] ??= await import(moduleUrl(`../convex/${name}.ts`));

/** The fixture's base with a second, kept Item in it; then the first Item Deleted. */
async function deletedBase(t, options = {}) {
  let keptItem;
  const f = await based(t, {
    ...options,
    prepare: async s => {
      keptItem = s.item({ title: `Kept ${KEEP}`, body: `Kept body ${KEEP}` });
      await s.send(keptItem);
    },
  });
  const { s, itemId } = f;
  const current = (await s.read()).data.planningItems.filter(item => item.id === itemId).at(-1);
  await s.send({
    action: 'put-planning-item',
    operationId: randomUUID(),
    itemId,
    expectedVersion: current.version,
    status: 'deleted',
  });
  return { ...f, keptItem };
}
const purge = (s, itemId, operationId) =>
  modules.projectPlanningPurge.run._handler(s.ctx, { projectId: s.projectId, itemId, operationId });
const tables = s => convexRowJson(Object.fromEntries(Object.entries(s.tables).map(([k, v]) => [k, [...v]])));

test('line 2e: a whole Item in the stored base is purged there: no table or stored object keeps its words, the backup selects a scrubbed root, load, rebuild and the hosted read are clean, a kept Item stays, and a same-id rerun changes nothing', async t => {
  const { s, itemId, root } = await deletedBase(t);
  for (const words of [SECRET, OTHER])
    assert.ok(tableWords(s, words).length + storedWords(s, words).length > 0, 'the base holds the words');
  const operationId = randomUUID();
  const meter = meterWorkIO(s.ctx, s.tables);
  let result;
  const cost = await meter.cost(async () => {
    result = await purge(s, itemId, operationId);
  });
  meter.restore();
  t.diagnostic(`whole base Item purge: ${JSON.stringify(cost)}`);
  assert.ok(result?.purgedAt !== undefined, `the purge finishes in one run (${JSON.stringify(result)})`);
  for (const words of [SECRET, OTHER]) {
    assert.deepEqual(tableWords(s, words), [], `no table holds ${words}`);
    assert.deepEqual(storedWords(s, words), [], `no stored object holds ${words}`);
  }
  const backup = s.tables.projectBackups.get(s.backupId);
  assert.equal(backup.scrubbed?.operationId, operationId, 'the backup selects the scrubbed root');
  assert.notEqual(backupRootPin(backup).sha256, root.sha256);
  const purged = [...s.tables.projectObjects.values()].filter(
    row => row.projectId === s.projectId && row.purged,
  );
  assert.ok(purged.length >= 3, `the Item's records and their packs are tombstoned (${purged.length})`);
  for (const row of purged.slice(0, 3))
    await assert.rejects(
      exchangeObjectReader(s.ctx, false, 0).read(s.projectId, 'owner', [
        { sha256: row.digest, size: row.size },
      ]),
      error => code(error) === 'PURGED',
    );
  const entry = s.tables.hostedProjects
    .get(s.projectId)
    .itemPurges.find(item => item.operationId === operationId);
  assert.equal(entry.baseScrub, undefined, 'the finished entry keeps no scrub state');
  const loaded = await workLoad.load(s.ctx, s.projectId, 'owner');
  for (const words of [SECRET, OTHER]) assert.equal(JSON.stringify(loaded.data).includes(words), false);
  assert.ok(JSON.stringify(loaded.data).includes(KEEP), 'the kept Item stays whole');
  await modules.projectWorkIndexActions.ensure._handler(s.ctx, { projectId: s.projectId, rebuild: true });
  for (const words of [SECRET, OTHER])
    assert.deepEqual(tableWords(s, words), [], 'a rebuild brings no words back');
  assert.ok(tableWords(s, KEEP).length > 0, 'the rebuilt index keeps the kept Item');
  const read = JSON.stringify(JSON.parse(await readHosted(s.ctx, { projectId: s.projectId })).data);
  assert.equal(read.includes(SECRET) || read.includes(OTHER), false);
  const before = tables(s);
  const again = await purge(s, itemId, operationId);
  assert.equal(again.purgedAt, result.purgedAt, 'a same-id rerun answers the finished purge');
  assert.equal(tables(s), before, 'and changes nothing');
});

test('line 2e: the base scrub refuses a base record of the Item that is not in its purged form (a copy the purge list missed), and passes purged records and other Items’ records', () => {
  const itemId = randomUUID(),
    commentId = randomUUID(),
    operationId = randomUUID();
  const scrub = itemScrub({
    historyId: itemId,
    ids: [itemId],
    intentKeys: [],
    version: 2,
    rows: [],
    comments: [commentId],
    purgeOperationId: operationId,
    decisions: new Map(),
  });
  const missed = { id: randomUUID(), itemId, authorLabel: 'agent', text: `Spam ${SECRET}`, at: '' };
  assert.throws(
    () => scrub.check('planningComments', Buffer.from(recordBytes(missed))),
    error => code(error) === 'BAD_ARGUMENT' && /not on the purge/.test(error.message),
  );
  const done = purgedIndexValue('planningComments', missed, operationId, new Map());
  scrub.check('planningComments', Buffer.from(recordBytes(done)));
  scrub.check('planningComments', Buffer.from(recordBytes({ ...missed, itemId: randomUUID() })));
});

test('line 2e reference check: a chunk of the old whole Work that another backup’s Work still names is never tombstoned; the base is scrubbed all the same', async t => {
  const { s, itemId, root } = await deletedBase(t, { recipe: true });
  // A second backup (still uploading, so not a second stored base) over the same old root and whole Work.
  const backup = s.tables.projectBackups.get(s.backupId);
  s.tables.projectBackups.set('backup-2', { ...backup, _id: 'backup-2', status: 'uploading' });
  const work = [...s.tables.projectObjects.values()].find(row => row.projectId === s.projectId && row.recipe);
  assert.ok(work, 'the base keeps its whole Work in chunks');
  const result = await purge(s, itemId, randomUUID());
  assert.ok(result?.purgedAt !== undefined);
  assert.notEqual(backupRootPin(s.tables.projectBackups.get(s.backupId)).sha256, root.sha256, 'scrubbed');
  const after = [...s.tables.projectObjects.values()].find(row => row.digest === work.digest);
  assert.ok(after && !after.purged, 'the whole Work the other backup names stays');
  const recipe = [...s.tables.projectObjects.values()].find(row => row.digest === work.recipe.digest);
  assert.ok(recipe && !recipe.purged, 'and so do its recipe and chunks');
});

test('review finding 1: a base converted to Intents keeps the Item’s pre-conversion records inline (legacyIntentMerge); the scrub replaces them there and retires the old catalog chunks, the kept Item’s legacy copy stays', async t => {
  const { s, itemId } = await deletedBase(t, { legacy: true });
  for (const words of [SECRET, OTHER])
    assert.ok(storedWords(s, words).length > 0, 'the base holds the words');
  const result = await purge(s, itemId, randomUUID());
  assert.ok(result?.purgedAt !== undefined);
  for (const words of [SECRET, OTHER]) {
    assert.deepEqual(tableWords(s, words), [], `no table holds ${words}`);
    assert.deepEqual(storedWords(s, words), [], `no stored object holds ${words}`);
  }
  const loaded = await workLoad.load(s.ctx, s.projectId, 'owner');
  const legacy = loaded.data.legacyIntentMerge;
  assert.ok(legacy, 'the legacy copy stays');
  assert.equal(JSON.stringify(legacy).includes('Kept body legacy'), false, 'the Item’s legacy body is gone');
  assert.ok(JSON.stringify(legacy).includes(KEEP), 'the kept Item’s legacy record stays');
});

test('base purge replaces a linked successor’s archived Intent payload without retained intentKeys', async t => {
  const words = 'private-base-successor-fixture';
  const intent = itemId => ({
    kind: 'intent',
    id: successorIntentId(itemId),
    version: 0,
    at: '2026-11-01T10:00:00.000Z',
    outcome: words,
    constraints: words,
    creatorAccountId: 'owner',
    assigneeAccountIds: [],
    base: { head: 'b'.repeat(64), receiptId: 'main-fixture' },
    status: 'completed',
  });
  const { s, itemId } = await deletedBase(t, { legacy: itemId => [intent(itemId)] });
  const hosted = await import(moduleUrl('../convex/projectHostedRecords.ts'));
  await s.ctx.db.patch(s.projectId, {
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  await hosted.writeHostedRecord(s.ctx, {
    projectId: s.projectId,
    actor: 'owner',
    authorityEpoch: 1,
    expectedVersion: null,
    record: intent(itemId),
    planningItemId: itemId,
  });
  assert(storedWords(s, words).length, 'the original base has the successor payload');
  const done = await purge(s, itemId, randomUUID());
  assert(done?.purgedAt !== undefined);
  assert.deepEqual(storedWords(s, words), [], 'the original and replacement R2 base are clean');
  assert.deepEqual(tableWords(s, words), []);
});

/** The old whole Work's chunks in order, as its recipe stores them. */
function leaves(work) {
  const out = [];
  const builder = new ObjectRecipeBuilder((bytes, offset) => {
    if (offset !== null) out.push(Buffer.from(bytes));
    return { sha256: digest(bytes), size: bytes.length };
  });
  builder.update(work);
  builder.finish({ sha256: digest(work), size: work.length });
  return out;
}

test('review finding 2: a distinct object stored in chunks that shares a word-free chunk with the old whole Work still reads after the purge; the chunks holding the words are retired', async t => {
  // Eight filler Items: a run of word-free chunks between the Item's records.
  const { s, itemId, data } = await deletedBase(t, { recipe: 8 });
  const work = Buffer.from([...jsonChunks(data, 2)].join(''));
  const chunks = leaves(work);
  const needles = [SECRET, OTHER, itemId, '"Kept title"', '"Kept body"', '"Kept comment"'];
  const holds = chunks.map(chunk => needles.some(needle => chunk.includes(needle)));
  // Content-defined chunks resynchronise within two chunks after a change: a word-free chunk after two more is
  // repeated by the scrubbed Work (and so is one before the first change).
  const first = holds.indexOf(true);
  const index = chunks.findIndex(
    (_, i) =>
      i < chunks.length - 1 && (i < first - 1 || (i >= 2 && !holds[i] && !holds[i - 1] && !holds[i - 2])),
  );
  t.diagnostic(`chunks ${chunks.length}, words in ${JSON.stringify(holds)}, shared ${index}`);
  assert.ok(index >= 0, 'the fixture has a word-free chunk the scrubbed Work repeats');
  const other = Buffer.concat([chunks[index], Buffer.from(randomUUID().repeat(4000))]);
  const built = buildObjectRecipe(other);
  assert.ok(built.objects.has(digest(chunks[index])), 'the distinct object names the shared chunk');
  for (const bytes of built.objects.values()) await upload(s, bytes, s.projectId);
  const recipePin = await upload(s, built.bytes, s.projectId);
  await modules.projectObjectRecipeStore.bind._handler(s.ctx, {
    projectId: s.projectId,
    actor: 'owner',
    digest: digest(other),
    size: other.length,
    recipeDigest: recipePin.sha256,
    recipeSize: recipePin.size,
  });
  const read = () =>
    exchangeObjectReader(s.ctx, false, 0).read(s.projectId, 'owner', [
      { sha256: digest(other), size: other.length },
    ]);
  assert.ok((await read())[0].equals(other), 'it reads before the purge');
  const result = await purge(s, itemId, randomUUID());
  assert.ok(result?.purgedAt !== undefined);
  assert.ok((await read())[0].equals(other), 'and after it');
  for (const words of [SECRET, OTHER])
    assert.deepEqual(storedWords(s, words), [], `no stored object holds ${words}`);
  const retired = chunks.filter((_, i) => holds[i]).map(chunk => digest(chunk));
  for (const sha256 of retired)
    assert.ok(
      [...s.tables.projectObjects.values()].find(row => row.digest === sha256)?.purged,
      'a chunk holding the words is tombstoned',
    );
});

test('review finding 5: an Item with more comments than one purge removes is refused before the purge’s first step, with nothing written', async t => {
  const { s, itemId } = await deletedBase(t);
  const project = s.tables.hostedProjects.get(s.projectId);
  const generation = s.tables.projectWorkGenerations.get(project.work.generationId);
  // Item history lives in the data table (convex/projectWorkRecordTables.ts).
  const table = [
    s.tables.projectWorkDataRecords,
    s.tables.projectPlanningRecords,
    s.tables.projectWorkRecords,
  ].find(
    rows =>
      rows && [...rows.values()].some(row => row.collection === 'planningComments' && row.parent === itemId),
  );
  const sample =
    table && [...table.values()].find(row => row.collection === 'planningComments' && row.parent === itemId);
  assert.ok(sample && generation, 'the Item has an indexed comment');
  for (let n = 0; n < 2001; n++) {
    const id = `imported-${n}`;
    table.set(id, { ...sample, _id: id, key: randomUUID(), position: sample.position + n + 1 });
  }
  const before = workEventRows(s.tables).length;
  await assert.rejects(
    purge(s, itemId, randomUUID()),
    error => code(error) === 'BAD_ARGUMENT' && /more than 2000 comments/.test(error.message),
  );
  assert.equal(workEventRows(s.tables).length, before, 'no purge row');
  assert.equal(project.itemPurges?.length ?? 0, 0, 'no progress entry');
});
