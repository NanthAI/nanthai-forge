// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item b6588425 line 2d: a reported comment whose words are in the stored base checkpoint (its event and comment
// records in the base's record catalog, and the packs over them) is purged there too. The abuse review starts the
// purge; the base scrub (src/work-base-scrub.ts, convex/projectCommentPurgeBase*.ts) writes a new exchange root that
// the backup selects, every base reader reads it, and the replaced record objects and packs are tombstoned (a read
// refuses PURGED) and their bytes deleted from R2.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { defaultR2Objects } from './default-r2.mjs';
import { meterWorkIO } from './hosted-read-set.mjs';
import { readByteTree } from '../dist/native-exchange-tree.js';
import { jsonChunks } from '../dist/json-chunks.js';
import { recordBytes } from '../dist/work-exchange-records.js';
import { digest } from '../dist/hash.js';
import { backupRootPin, scrubExchange, commentScrubTargets } from '../dist/work-base-scrub.js';
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

/** Run the scheduled comment purges as the scheduler would. */
async function runScheduled(s) {
  const results = [];
  for (
    let task;
    (task = s.scheduled.find(x => getFunctionName(x.fn) === 'projectCommentPurgeArchive:run'));
  ) {
    s.scheduled.splice(s.scheduled.indexOf(task), 1);
    results.push(await modules.projectCommentPurgeArchive.run._handler(s.ctx, task.args));
    assert.ok(results.length <= 4, 'the purge finishes in a few runs');
  }
  return results;
}
const auditDetail = s => JSON.parse([...s.tables.boardAudit.values()].at(-1).detail);

test('a base comment’s purge scrubs the stored base: the backup selects a new root without the words, load and index rebuild read it, the old record objects and packs refuse PURGED and leave R2', async t => {
  const { s, itemId, reported, review, root } = await based(t);
  assert.ok(tableWords(s).length + storedWords(s).length > 0, 'the fixture holds the words before the purge');
  t.diagnostic(`before: ${JSON.stringify({ tables: tableWords(s), stored: storedWords(s).length })}`);
  await assert.rejects(
    modules.projectCommentPurge.purge._handler(s.ctx, {
      projectId: s.projectId,
      itemId,
      commentId: reported.operationId,
      operationId: randomUUID(),
    }),
    error => code(error) === 'BAD_ARGUMENT' && /scrubs the stored base/.test(error.message),
    'the direct purge sends a base comment to the action',
  );
  assert.deepEqual(await modules.abuseReports.review._handler(s.ctx, review), {
    reportId: 'report-1',
    status: 'purged',
    removed: 0,
  });
  const meter = meterWorkIO(s.ctx, s.tables);
  let results;
  const cost = await meter.cost(async () => {
    results = await runScheduled(s);
  });
  meter.restore();
  assert.deepEqual(results, ['done']);
  t.diagnostic(`base comment purge: ${JSON.stringify(cost)}`);
  assert.equal(auditDetail(s).done, true, 'the audit row is done');
  assert.deepEqual(tableWords(s), [], 'no table holds the words');
  assert.deepEqual(storedWords(s), [], 'no stored object holds the words');
  const backup = s.tables.projectBackups.get(s.backupId);
  assert.ok(backup.scrubbed, 'the backup selects the scrubbed root');
  assert.notEqual(backupRootPin(backup).sha256, root.sha256);
  const old = [...s.tables.projectObjects.values()].find(row => row.digest === root.sha256);
  assert.ok(old && !old.purged, 'the original root itself names no words and stays');
  const purged = [...s.tables.projectObjects.values()].filter(
    row => row.projectId === s.projectId && row.purged,
  );
  assert.ok(
    purged.length >= 3,
    `the comment record, its event and their pack are tombstoned (${purged.length})`,
  );
  assert.equal(new Set(purged.map(row => row.purged.operationId)).size, 1, 'by the one purge');
  for (const row of purged) {
    await assert.rejects(
      exchangeObjectReader(s.ctx, false, 0).read(s.projectId, 'owner', [
        { sha256: row.digest, size: row.size },
      ]),
      error => code(error) === 'PURGED',
      'a read of a replaced object refuses PURGED',
    );
  }
  const entry = s.tables.hostedProjects
    .get(s.projectId)
    .itemPurges.find(item => item.commentId === reported.operationId);
  assert.ok(entry.purgedAt, 'the purge entry is finished');
  assert.equal(entry.baseScrub, undefined, 'and keeps no scrub state');
  // Every base reader reads the scrubbed root: a full load, the hosted read, an index rebuild.
  const loaded = await workLoad.load(s.ctx, s.projectId, 'owner');
  assert.equal(JSON.stringify(loaded.data).includes(SECRET), false);
  const comment = loaded.data.planningComments.find(row => row.id === reported.operationId);
  assert.equal(comment.text, 'Deleted comment');
  assert.ok(
    loaded.data.planningComments.some(row => row.text === 'Kept comment'),
    'the other comment stays',
  );
  assert.ok(
    loaded.data.planningItems.some(row => row.id === itemId),
    'the Item stays',
  );
  await modules.projectWorkIndexActions.ensure._handler(s.ctx, { projectId: s.projectId, rebuild: true });
  assert.deepEqual(tableWords(s), [], 'a rebuild from the scrubbed base brings no words back');
  const read = JSON.parse(await readHosted(s.ctx, { projectId: s.projectId })).data;
  assert.equal(JSON.stringify(read).includes(SECRET), false);
  // A retried review changes nothing.
  const tables = () =>
    JSON.stringify(Object.fromEntries(Object.entries(s.tables).map(([k, v]) => [k, [...v]])));
  const before = tables();
  await modules.abuseReports.review._handler(s.ctx, review);
  assert.deepEqual(await runScheduled(s), []);
  assert.equal(tables(), before);
});

test('scrubExchange replaces only the target records and their packs, measures the new whole-Work digest, and changes nothing for a comment it does not hold', async t => {
  const { reported, tree, data } = await based(t);
  const objects = tree.objects,
    purge = randomUUID();
  const read = async pins => pins.map(pin => objects.get(pin.sha256) ?? assert.fail(`missing ${pin.sha256}`));
  const scrub = await scrubExchange({
    rootBytes: tree.bytes,
    read,
    targets: commentScrubTargets(reported.operationId),
    purgeOperationId: purge,
  });
  assert.equal(scrub.changed, 2, 'the comment record and its event');
  assert.equal(scrub.originalWork, digest(Buffer.from([...jsonChunks(data, 2)].join(''))));
  assert.notEqual(scrub.work.sha256, scrub.originalWork);
  for (const pin of scrub.replaced)
    assert.ok(objects.get(pin.sha256).includes(SECRET), 'each replaced object held the words');
  for (const bytes of scrub.objects.values()) assert.equal(bytes.includes(SECRET), false);
  const all = new Map([...objects, ...scrub.objects]);
  const next = JSON.parse(scrub.objects.get(scrub.root.sha256).toString());
  const manifest = await readByteTree(next.manifest, async pins => pins.map(pin => all.get(pin.sha256)));
  assert.equal(digest(manifest), scrub.manifestDigest);
  assert.deepEqual(
    JSON.parse(manifest).files.find(file => file.path === 'work.json'),
    { ...JSON.parse(manifest).files.find(file => file.path === 'work.json'), ...scrub.work },
  );
  assert.equal(
    await scrubExchange({
      rootBytes: tree.bytes,
      read,
      targets: commentScrubTargets(randomUUID()),
      purgeOperationId: purge,
    }),
    undefined,
  );
  // A scrub of the scrubbed root is a fixed point.
  assert.equal(
    await scrubExchange({
      rootBytes: scrub.objects.get(scrub.root.sha256),
      read: async pins => pins.map(pin => all.get(pin.sha256)),
      targets: commentScrubTargets(reported.operationId),
      purgeOperationId: purge,
    }),
    undefined,
  );
});

test('a base comment whose journal row is kept at the base, and a base decision comment, are scrubbed too: the row, the comment, its event and the derived body version lose the words; only the base Intent’s copy of the body keeps the line as history', async t => {
  for (const options of [{ rows: true }, { decision: true }]) {
    const { s, review, itemId, data } = await based(t, options);
    await modules.abuseReports.review._handler(s.ctx, review);
    assert.deepEqual(await runScheduled(s), ['done'], JSON.stringify(options));
    const loaded = await workLoad.load(s.ctx, s.projectId, 'owner');
    assert.equal(JSON.stringify(loaded.data).includes(SECRET), false, JSON.stringify(options));
    assert.ok(JSON.stringify(loaded.data).includes(OTHER), 'the other reported comment keeps its words');
    if (!options.decision) {
      assert.deepEqual(tableWords(s), []);
      assert.deepEqual(storedWords(s), []);
      continue;
    }
    // docs/planning.md "Removing one comment": the Intent's copies of the body keep the line as history.
    const intendedBodies = new Set(
      [...s.tables.projectHostedRecords.values()]
        .filter(row => row.kind === 'intent' && row.key === itemId)
        .map(row => `projectHostedRecordBodies::${row.bodyId}`),
    );
    assert.deepEqual(
      tableWords(s).filter(
        row => !row.startsWith('projectWorkDataRecords:intents:payload:') && !intendedBodies.has(row),
      ),
      [],
    );
    const intent = recordBytes(data.intents.find(row => row.id === itemId));
    assert.ok(intent.includes(SECRET));
    for (const key of storedWords(s))
      assert.ok(
        Buffer.from(defaultR2Objects.get(key)).includes(intent),
        `${key} holds only the Intent's copy`,
      );
    const versions = loaded.data.planningItems.filter(
      row => row.id === itemId && row.body?.includes('(comment '),
    );
    assert.ok(versions.length >= 2, 'the derived version and the current body keep the line, emptied');
    assert.ok(versions.every(row => /Deleted comment \(comment [0-9a-f]{8}\)/.test(row.body)));
  }
});

test('a base the scrub cannot rewrite (another stored base checkpoint) is refused before anything is written: the report reopens and a later review runs again', async t => {
  const { s, review } = await based(t);
  const backup = s.tables.projectBackups.get(s.backupId);
  s.tables.projectBackups.set('older', { ...backup, _id: 'older', scrubbed: undefined });
  const before = tableWords(s);
  await modules.abuseReports.review._handler(s.ctx, review);
  assert.deepEqual(await runScheduled(s), ['failed']);
  assert.deepEqual(tableWords(s), before, 'nothing was purged');
  assert.equal(s.tables.projectBackups.get(s.backupId).scrubbed, undefined);
  assert.equal(auditDetail(s).failed, 'BAD_ARGUMENT');
  assert.equal(s.tables.abuseReports.get('report-1').status, 'open');
  s.tables.projectBackups.delete('older');
  await modules.abuseReports.review._handler(s.ctx, review);
  assert.deepEqual(await runScheduled(s), ['done'], 'a retry of the review runs it anew');
});

test('two base comment purges at once run one after the other: the second waits (nothing written) while the first scrubs, then scrubs the first one’s root; neither comment keeps its words', async t => {
  const { s, review, otherReview } = await based(t);
  await modules.abuseReports.review._handler(s.ctx, review);
  await modules.abuseReports.review._handler(s.ctx, otherReview);
  const [, second] = s.scheduled.filter(x => getFunctionName(x.fn) === 'projectCommentPurgeArchive:run');
  s.scheduled.splice(s.scheduled.indexOf(second), 1);
  const store = modules.projectCommentPurgeBaseStore;
  let raced;
  modules.projectCommentPurgeBaseStore = {
    ...store,
    publish: {
      _handler: async (ctx, args) => {
        // The other purge starts between this purge's build and its publication.
        if (!raced) {
          const before = tableWords(s, OTHER);
          raced = await modules.projectCommentPurgeArchive.run._handler(s.ctx, second.args);
          assert.deepEqual(tableWords(s, OTHER), before, 'the waiting purge wrote nothing');
        }
        return store.publish._handler(ctx, args);
      },
    },
  };
  t.after(() => (modules.projectCommentPurgeBaseStore = store));
  assert.deepEqual(await runScheduled(s), ['done', 'done'], 'the first finishes, then the second');
  assert.equal(raced, 'continues', 'the second waited');
  for (const words of [SECRET, OTHER]) {
    assert.deepEqual(tableWords(s, words), []);
    assert.deepEqual(storedWords(s, words), []);
  }
  const loaded = await workLoad.load(s.ctx, s.projectId, 'owner');
  assert.equal(JSON.stringify(loaded.data).includes(SECRET), false);
  assert.equal(JSON.stringify(loaded.data).includes(OTHER), false);
});

test('a publication over a base root that changed since the build is refused (WORK_STALE); the retry builds again over the current root and finishes', async t => {
  const { s, review } = await based(t);
  await modules.abuseReports.review._handler(s.ctx, review);
  const store = modules.projectCommentPurgeBaseStore;
  let refused;
  modules.projectCommentPurgeBaseStore = {
    ...store,
    publish: {
      _handler: async (ctx, args) => {
        if (refused) return store.publish._handler(ctx, args);
        // Another root is selected while this build was made.
        const backup = s.tables.projectBackups.get(s.backupId),
          selected = backup.objectManifest;
        backup.objectManifest = { digest: '0'.repeat(64), size: 1 };
        try {
          return await store.publish._handler(ctx, args);
        } catch (error) {
          refused = code(error);
          throw error;
        } finally {
          backup.objectManifest = selected;
        }
      },
    },
  };
  t.after(() => (modules.projectCommentPurgeBaseStore = store));
  assert.deepEqual(await runScheduled(s), ['continues', 'done']);
  assert.equal(refused, 'WORK_STALE');
  assert.equal(s.tables.projectBackups.get(s.backupId).scrubbed.operationId.length > 0, true);
  assert.deepEqual(tableWords(s), []);
});

test('a base comment written before hosted Work (a comment record, no event) is purged from its record: the purge command comes from it, and a second purge reports 0', async t => {
  const { s, review, itemId, reported } = await based(t, { imported: true });
  await modules.abuseReports.review._handler(s.ctx, review);
  assert.deepEqual(await runScheduled(s), ['done']);
  assert.deepEqual(tableWords(s), []);
  assert.deepEqual(storedWords(s), []);
  const loaded = await workLoad.load(s.ctx, s.projectId, 'owner');
  assert.equal(
    loaded.data.planningComments.find(row => row.id === reported.operationId).text,
    'Deleted comment',
  );
  const again = await modules.projectCommentPurge.purge._handler(s.ctx, {
    projectId: s.projectId,
    itemId,
    commentId: reported.operationId,
    operationId: randomUUID(),
    base: true,
  });
  assert.equal(again, 0, 'an earlier purge already removed it');
});

test('a seed’s whole work.json stored in chunks is removed with the base: its recipe row, recipe and chunks refuse PURGED and leave R2', async t => {
  const { s, review } = await based(t, { recipe: true });
  const recipeRow = [...s.tables.projectObjects.values()].find(row => row.recipe);
  assert.ok(recipeRow, 'the fixture stores the whole Work behind a recipe');
  await modules.abuseReports.review._handler(s.ctx, review);
  assert.deepEqual(await runScheduled(s), ['done']);
  assert.deepEqual(tableWords(s), []);
  assert.deepEqual(storedWords(s), [], 'no chunk keeps the words');
  assert.ok(s.tables.projectObjects.get(recipeRow._id).purged, 'the whole Work refuses PURGED');
});

test('a same-id retry of a finished base purge answers done and changes nothing', async t => {
  const { s, review } = await based(t);
  await modules.abuseReports.review._handler(s.ctx, review);
  const [task] = s.scheduled.filter(x => getFunctionName(x.fn) === 'projectCommentPurgeArchive:run');
  assert.deepEqual(await runScheduled(s), ['done']);
  const tables = () =>
    JSON.stringify(Object.fromEntries(Object.entries(s.tables).map(([k, v]) => [k, [...v]])));
  const before = tables();
  assert.equal(await modules.projectCommentPurgeArchive.run._handler(s.ctx, task.args), 'done');
  assert.equal(tables(), before);
});

test('another stored backup that appears between the build and the publication is refused there: nothing of the base is tombstoned', async t => {
  const { s, review } = await based(t);
  await modules.abuseReports.review._handler(s.ctx, review);
  const store = modules.projectCommentPurgeBaseStore;
  modules.projectCommentPurgeBaseStore = {
    ...store,
    publish: {
      _handler: async (ctx, args) => {
        const backup = s.tables.projectBackups.get(s.backupId);
        s.tables.projectBackups.set('later', { ...backup, _id: 'later' });
        return store.publish._handler(ctx, args);
      },
    },
  };
  t.after(() => (modules.projectCommentPurgeBaseStore = store));
  const results = await runScheduled(s).catch(error => [code(error)]);
  assert.notDeepEqual(results, ['done']);
  assert.equal(s.tables.projectBackups.get(s.backupId).scrubbed, undefined, 'nothing published');
  assert.equal(
    [...s.tables.projectObjects.values()].some(row => row.purged),
    false,
    'nothing tombstoned',
  );
});
