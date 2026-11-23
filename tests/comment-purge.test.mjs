// SPDX-License-Identifier: Apache-2.0
// Item b6588425 line 2b: the operator's purge of one reported planning comment removes its words from every Work
// store and copy (journal row, index records on every partition, work-store versions and head, attachments), keeps
// the Item and its other comments, leaves a tombstone, is idempotent by operation id, is audited, and is what the
// abuse review's purge action runs for a comment (convex/projectCommentPurge.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { setup, actions } from './hosted-planning-fixture.mjs';
import { meterWorkIO } from './hosted-read-set.mjs';
import { digest } from '../dist/hash.js';
import { dispatchHostedWork } from '../dist/hosted-work-client.js';
import { moduleUrl } from './convex-module.mjs';
import { gunzipSync } from 'node:zlib';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { encodeArchiveBytes } from '../dist/landing-capsule-bytes.js';
import { journalSegmentText, journalTablePins } from '../dist/journal-segment.js';

const SECRET = 'wombat-comment-purge-fixture';
const code = expected => error => (error.data?.code ?? error.code) === expected;
const commentPurge = await import(moduleUrl('../convex/projectCommentPurge.ts'));
const reports = await import(moduleUrl('../convex/abuseReports.ts'));
const workStore = await import(moduleUrl('../convex/projectWorkStore.ts'));
const workIndex = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const hostedRecords = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const artifactStorage = await import(moduleUrl('../convex/artifactStorage.ts'));
const { ensure } = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
const planningPurge = await import(moduleUrl('../convex/projectPlanningPurge.ts'));
const routed = {
  projectCommentPurge: commentPurge,
  projectCommentPurgeArchive: await import(moduleUrl('../convex/projectCommentPurgeArchive.ts')),
  projectCommentPurgeArchiveStore: await import(moduleUrl('../convex/projectCommentPurgeArchiveStore.ts')),
  projectPlanningPurgeSegmentRun: await import(moduleUrl('../convex/projectPlanningPurgeSegmentRun.ts')),
  projectPlanningPurgeSegments: await import(moduleUrl('../convex/projectPlanningPurgeSegments.ts')),
  projectJournalRead: await import(moduleUrl('../convex/projectJournalRead.ts')),
};
const { readHosted } = await import('./hosted-read.mjs');

const secretRows = s =>
  Object.entries(s.tables).flatMap(([table, rows]) =>
    [...rows.values()]
      .filter(row => JSON.stringify(row).includes(SECRET))
      .map(row => `${table}:${row.collection ?? row.kind ?? ''}:${row.key ?? row.operationId ?? ''}`),
  );

/** Copy the Work into the store and make it the primary reader (records mode), as projects run today. */
async function recordsMode(s) {
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
  s.tables.hostedProjects.get(s.projectId).sourceAuthority = { mode: 'server', epoch: 1 };
  await dispatchHostedWork(client, s.projectId, { action: 'copy-work-store' });
  await dispatchHostedWork(client, s.projectId, { action: 'set-work-store', mode: 'records' });
}

/** An Item with a kept comment, the reported comment (with an attachment), a reply to it and a later put. */
async function commented(t, { records = false, primary = false, decision = false, laterPut = true } = {}) {
  const s = await setup(t);
  if (records || primary) await recordsMode(s);
  // Planning as a primary store writer: its commands' rows live in the store's record bodies, not the event table.
  if (primary)
    await workStore.setMode._handler(s.ctx, {
      projectId: s.projectId,
      mode: 'records',
      writers: ['planning', 'note'],
    });
  const item = s.item({ title: 'Kept title', body: 'Kept body' });
  await s.send(item);
  const comment = (text, extra = {}) => ({
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId: item.itemId,
    authorLabel: 'agent',
    text,
    ...extra,
  });
  const kept = comment('Kept comment');
  const reported = comment(`Spam ${SECRET}`, decision ? { decision: true } : {});
  const reply = comment('Kept reply', { replyTo: reported.operationId });
  for (const command of [kept, reported, reply]) await s.send(command);
  // A decision's later put keeps the body (and so the decision's line), as a status or title edit does.
  const later = {
    ...s.item({ itemId: item.itemId, expectedVersion: decision ? 2 : 1 }),
    title: 'Kept title 2',
  };
  if (decision) delete later.body;
  if (!decision || laterPut) await s.send(later);
  const attachment = await artifactStorage.reserve._handler(s.ctx, {
    namespace: `v1/p/${s.projectId}/discussion/${item.itemId}/${reported.operationId}`,
    digest: digest(SECRET),
    size: SECRET.length,
    contentType: 'text/plain',
  });
  assert.ok(secretRows(s).length > 0, 'the fixture holds the words before the purge');
  return { s, itemId: item.itemId, kept, reported, reply, attachment };
}

const purge = (s, itemId, commentId, operationId = randomUUID()) =>
  commentPurge.purge._handler(s.ctx, { projectId: s.projectId, itemId, commentId, operationId });
const comments = (data, itemId) => data.planningComments.filter(row => row.itemId === itemId);

for (const mode of ['journal', 'records', 'primary-writer'])
  test(`${mode} mode: one comment's purge leaves its words in no table, keeps the Item, its other comments and the thread, and nothing comes back on a rebuild, load or export`, async t => {
    const { s, itemId, kept, reported, reply } = await commented(t, {
      records: mode === 'records',
      primary: mode === 'primary-writer',
    });
    const operationId = randomUUID();
    assert.equal(await purge(s, itemId, reported.operationId, operationId), 1);
    assert.deepEqual(secretRows(s), [], 'no table holds the purged words');
    const check = async label => {
      const data = (await s.read()).data;
      assert.equal(JSON.stringify(data).includes(SECRET), false, label);
      assert.equal(data.planningItems.filter(row => row.id === itemId).at(-1).title, 'Kept title 2', label);
      const byId = new Map(comments(data, itemId).map(row => [row.id, row]));
      assert.equal(byId.get(kept.operationId).text, 'Kept comment', label);
      assert.equal(byId.get(reported.operationId).text, 'Deleted comment', `${label}: the tombstone stays`);
      assert.equal(byId.get(reply.operationId).text, 'Kept reply', label);
      assert.equal(byId.get(reply.operationId).replyTo, reported.operationId, `${label}: the thread stays`);
    };
    await check('full load');
    const project = s.tables.hostedProjects.get(s.projectId);
    assert.equal(project.planningPurgeRevision, 1, 'a load that began before the purge refuses to finish');
    s.tables.projectWorkGenerations.get(project.work.generationId).format = 3;
    await ensure._handler(s.ctx, { projectId: s.projectId, rebuild: true });
    assert.deepEqual(secretRows(s), [], 'a rebuild brings no words back');
    await check('after a rebuild');
    const journal = await actions.exportJournal._handler(s.ctx, { projectId: s.projectId, purgedRows: 3 });
    assert.equal(journal.includes(SECRET), false);
    assert.ok(journal.includes('purge-planning-comment'), 'the export carries the tombstone command');
    await assert.rejects(
      actions.exportJournal._handler(s.ctx, { projectId: s.projectId, purgedRows: 2 }),
      code('CLI_UPGRADE_REQUIRED'),
      'a CLI that cannot replay a comment purge is told to update',
    );
    const page = await workIndex.records._handler(s.ctx, {
      projectId: s.projectId,
      collection: 'planningComments',
      parentId: itemId,
      paginationOpts: { cursor: null, numItems: 100 },
    });
    assert.equal(JSON.stringify(page).includes(SECRET), false);
    assert.deepEqual(
      page.page.map(row => JSON.parse(row.value).text).sort(),
      ['Deleted comment', 'Kept comment', 'Kept reply'],
      'the Item’s comment read lists the tombstone in place',
    );
  });

test('records mode: a purged comment version and a retry of the comment answer PLANNING_COMMENT_PURGED naming the comment', async t => {
  const { s, itemId, reported } = await commented(t, { records: true });
  await purge(s, itemId, reported.operationId);
  const version = [...s.tables.projectHostedRecords.values()].find(
    row => row.kind === 'comment' && row.key === reported.operationId,
  );
  await assert.rejects(hostedRecords.hostedRecordBody(s.ctx, version), error => {
    assert.equal(error.data?.code ?? error.code, 'PLANNING_COMMENT_PURGED');
    assert.match(error.message, /Item .* is unchanged/);
    return true;
  });
  // The abuser's agent resending its comment gets the refusal, never a second copy.
  await assert.rejects(s.send(reported), code('PLANNING_COMMENT_PURGED'));
  // The comment purge vouches for this one comment only: another comment marked with it stays an integrity failure.
  const other = [...s.tables.projectHostedRecords.values()].find(
    row => row.kind === 'comment' && row.parent === itemId && row.key !== reported.operationId,
  );
  await assert.rejects(
    hostedRecords.hostedRecordBody(s.ctx, { ...other, purged: version.purged }),
    code('SOURCE_UNAVAILABLE'),
  );
});

test('records mode: a head stored before heads kept their value gets the tombstone; a failed build’s staged pages go; an unfinished table migration’s old copy refuses', async t => {
  const { s, itemId, reported } = await commented(t, { records: true });
  const head = [...s.tables.projectHostedRecordHeads.values()].find(
    row => row.kind === 'comment' && row.key === reported.operationId,
  );
  delete head.value;
  const [generation] = [...s.tables.projectWorkGenerations.values()];
  s.tables.projectWorkGenerations.set('failed', { ...generation, _id: 'failed', status: 'failed' });
  s.tables.projectReturnPages ??= new Map();
  s.tables.projectReturnPages.set('staged', {
    _id: 'staged',
    _creationTime: 1,
    projectId: s.projectId,
    partitionId: 'failed',
    key: 'batch',
    position: 0,
    body: `[${JSON.stringify(SECRET)}]`,
  });
  const legacy = {
    _id: 'legacy',
    _creationTime: 1,
    projectId: s.projectId,
    generationId: generation._id,
    collection: 'planningComments',
    key: reported.operationId,
    parent: itemId,
    position: 0,
    value: '{}',
  };
  s.tables.projectWorkRecords.set('legacy', legacy);
  await assert.rejects(purge(s, itemId, reported.operationId), code('WORK_STALE'));
  assert.ok(s.tables.projectReturnPages.has('staged'), 'the refusal wrote nothing');
  s.tables.projectWorkRecords.delete('legacy');
  assert.equal(await purge(s, itemId, reported.operationId), 1);
  assert.equal(s.tables.projectReturnPages.has('staged'), false, 'the failed build’s staged page is deleted');
  assert.equal(JSON.parse(head.value).text, 'Deleted comment', 'the head reads the tombstone inline');
  assert.deepEqual(secretRows(s), []);
});

test('a comment purge is idempotent by operation id, changes nothing on retry, and reports 0 when the comment is already gone', async t => {
  const { s, itemId, reported, attachment } = await commented(t);
  const operationId = randomUUID();
  assert.equal(await purge(s, itemId, reported.operationId, operationId), 1);
  assert.equal(s.tables.artifactBlobs.get(attachment._id).removed, true, 'the attachment binding is removed');
  assert.ok(
    s.scheduled.some(task => getFunctionName(task.fn) === 'artifactStorage:deleteBytes'),
    'its R2 bytes are queued for cleanup',
  );
  const snapshot = JSON.stringify([...s.tables.projectWorkEvents.values()]);
  const revision = s.tables.hostedProjects.get(s.projectId).planningPurgeRevision;
  assert.equal(
    await purge(s, itemId, reported.operationId, operationId),
    1,
    'a retry reports the same result',
  );
  assert.equal(JSON.stringify([...s.tables.projectWorkEvents.values()]), snapshot, 'and appends nothing');
  assert.equal(s.tables.hostedProjects.get(s.projectId).planningPurgeRevision, revision);
  assert.equal(
    await purge(s, itemId, reported.operationId),
    0,
    'another purge of the same comment removes nothing',
  );
  await assert.rejects(
    purge(s, randomUUID(), reported.operationId),
    code('NOT_FOUND'),
    'it must name its Item',
  );
});

/** The rows that still hold the words after a decision's purge: only Intent copies of the Item's body from the
 * decision's version (history; docs/planning.md "Removing one comment"), never a comment, an index read or a head. */
const intentHistoryOnly = s =>
  secretRows(s).filter(row => {
    if (row.startsWith('projectWorkDataRecords:intents:payload:')) return false;
    if (!row.startsWith('projectHostedRecordBodies:')) return true;
    const body = [...s.tables.projectHostedRecordBodies.values()].find(
      item =>
        JSON.stringify(item).includes(SECRET) &&
        `projectHostedRecordBodies::${item.operationId ?? ''}` === row,
    );
    return ![...s.tables.projectHostedRecords.values()].some(
      record => record.bodyId === body?._id && record.kind === 'intent',
    );
  });

for (const mode of ['journal', 'records', 'primary-writer'])
  test(`${mode} mode: a decision comment's purge removes its words from the comment, the derived version and the current body by one audited edit; a retry, rebuild, load and export bring none back`, async t => {
    const { s, itemId, reported } = await commented(t, {
      decision: true,
      laterPut: false,
      records: mode === 'records',
      primary: mode === 'primary-writer',
    });
    const operationId = randomUUID();
    assert.equal(await purge(s, itemId, reported.operationId, operationId), 1);
    assert.deepEqual(intentHistoryOnly(s), [], 'only Intent history copies of the body keep the line');
    const check = async label => {
      const data = (await s.read()).data;
      assert.equal(JSON.stringify(data).includes(SECRET), false, label);
      const versions = data.planningItems.filter(row => row.id === itemId);
      const current = versions.at(-1);
      assert.equal(current.reason, commentPurge.DECISION_EDIT_REASON, `${label}: the edit says why`);
      assert.match(
        current.body,
        /Deleted comment \(comment [0-9a-f]{8}\)/,
        `${label}: the line stays, emptied`,
      );
      assert.match(
        versions.at(-2).body,
        /Deleted comment/,
        `${label}: the decision's derived version replays emptied`,
      );
    };
    await check('full load');
    const events = s.tables.projectWorkEvents.size,
      bodies = s.tables.projectHostedRecordBodies?.size;
    assert.equal(await purge(s, itemId, reported.operationId, operationId), 1, 'a retry answers the same');
    assert.equal(s.tables.projectWorkEvents.size, events, 'and appends no Work row');
    assert.equal(s.tables.projectHostedRecordBodies?.size, bodies, 'and stores no record body');
    const project = s.tables.hostedProjects.get(s.projectId);
    s.tables.projectWorkGenerations.get(project.work.generationId).format = 3;
    await ensure._handler(s.ctx, { projectId: s.projectId, rebuild: true });
    assert.deepEqual(intentHistoryOnly(s), [], 'a rebuild brings no words back');
    await check('after a rebuild');
    const journal = await actions.exportJournal._handler(s.ctx, { projectId: s.projectId, purgedRows: 3 });
    assert.equal(journal.includes(SECRET), false);
  });

test('a decision purge after a later put: the current body is edited; the carried-forward version keeps its line as history', async t => {
  const { s, itemId, reported } = await commented(t, { decision: true });
  assert.equal(await purge(s, itemId, reported.operationId), 1);
  const data = (await s.read()).data;
  const versions = data.planningItems.filter(row => row.id === itemId);
  assert.equal(versions.at(-1).reason, commentPurge.DECISION_EDIT_REASON);
  assert.equal(versions.at(-1).body.includes(SECRET), false);
  assert.equal(versions.at(-1).title, 'Kept title 2', 'the edit keeps the rest of the Item');
  assert.equal(comments(data, itemId).find(row => row.id === reported.operationId).text, 'Deleted comment');
});

test('hosted display snapshots lose the comment’s rows (and the derived version’s) and keep every other row', async t => {
  const { s, itemId, reported } = await commented(t, { decision: true, laterPut: false });
  const snapshotId = await s.ctx.db.insert('projectHostedSnapshots', {
    projectId: s.projectId,
    actor: 'owner',
    operationId: randomUUID(),
    snapshotId: 'snap',
    authorityEpoch: 1,
    expectedSnapshotId: null,
    journalSequence: 1,
    seedCheckpoint: { sha256: 'a'.repeat(64), size: 1 },
    source: { head: 'b'.repeat(64), receiptId: randomUUID() },
    pageCount: 1,
    recordCount: 3,
    root: 'c'.repeat(64),
    request: 'd'.repeat(64),
    at: 1,
    nextPage: 1,
    stagedRecords: 3,
    stagedRoot: 'c'.repeat(64),
    lastKey: null,
    status: 'published',
  });
  const display = (kind, key, version) =>
    s.ctx.db.insert('projectHostedDisplayRecords', {
      projectId: s.projectId,
      snapshotId,
      kind,
      key,
      version,
      parent: itemId,
      status: 'open',
      value: `${kind} ${SECRET}`,
    });
  await display('comment', reported.operationId, 1);
  await display('issue', itemId, 2);
  const kept = await display('issue', itemId, 1);
  await purge(s, itemId, reported.operationId);
  assert.deepEqual([...s.tables.projectHostedDisplayRecords.keys()], [kept]);
});

test('a purge while a Work index builds is refused with nothing written; a base-checkpoint comment is refused', async t => {
  const { s, itemId, reported } = await commented(t);
  const generation = [...s.tables.projectWorkGenerations.values()][0];
  s.tables.projectWorkGenerations.set('building', { ...generation, _id: 'building', status: 'building' });
  await assert.rejects(purge(s, itemId, reported.operationId), code('WORK_STALE'));
  assert.equal(secretRows(s).length > 0, true, 'nothing was purged');
  s.tables.projectWorkGenerations.delete('building');
  const row = [...s.tables.projectWorkEvents.values()].find(
    item => item.operationId === reported.operationId,
  );
  const before = row.revision;
  // The selected generation starts after the comment, as an import or a checkpoint leaves it.
  for (const item of s.tables.projectWorkGenerations.values()) item.initialRevision = before;
  await assert.rejects(purge(s, itemId, reported.operationId), error => {
    assert.equal(error.data?.code ?? error.code, 'BAD_ARGUMENT');
    assert.match(error.message, /base checkpoint/);
    return true;
  });
});

test('purge cost: one comment, one record partition: bounded reads and writes, independent of the Item’s other comments', async t => {
  const measure = async extra => {
    const { s, itemId, reported } = await commented(t);
    for (let n = 0; n < extra; n++)
      await s.send({
        action: 'comment-planning-item',
        operationId: randomUUID(),
        itemId,
        authorLabel: 'agent',
        text: `Other ${n}`,
      });
    const meter = meterWorkIO(s.ctx, s.tables);
    const cost = await meter.cost(() => purge(s, itemId, reported.operationId));
    meter.restore();
    return cost;
  };
  const few = await measure(0),
    many = await measure(30);
  t.diagnostic(`comment purge: ${JSON.stringify(few)}`);
  // A decision's purge adds the audited put and the derived version's rewrite: still a few dozen documents.
  const { s, itemId, reported } = await commented(t, { decision: true, laterPut: false });
  const meter = meterWorkIO(s.ctx, s.tables);
  const decided = await meter.cost(() => purge(s, itemId, reported.operationId));
  meter.restore();
  t.diagnostic(`decision comment purge: ${JSON.stringify(decided)}`);
  assert.ok(decided.writeDocuments <= 40, `decision writes stay small (${decided.writeDocuments})`);
  assert.ok(decided.readDocuments <= 120, `decision reads stay small (${decided.readDocuments})`);
  assert.ok(few.writeDocuments <= 16, `writes stay small (${few.writeDocuments})`);
  assert.ok(few.readDocuments <= 60, `reads stay small (${few.readDocuments})`);
  assert.equal(many.writeDocuments, few.writeDocuments, 'other comments add no writes');
  assert.ok(many.readDocuments <= few.readDocuments + 2, 'other comments add no reads');
});

test('the abuse review purges a reported comment: one audit row, the report purged, a retry changes nothing', async t => {
  const { s, itemId, reported } = await commented(t);
  s.tables.abuseReports ??= new Map();
  s.tables.boardAudit ??= new Map();
  const reportId = 'report-1';
  s.tables.abuseReports.set(reportId, {
    _id: reportId,
    _creationTime: 1,
    operationId: randomUUID(),
    reporter: 'reporter',
    kind: 'comment',
    projectId: s.projectId,
    itemId,
    targetId: reported.operationId,
    subject: 'owner',
    excerpt: `Spam ${SECRET}`,
    reason: 'Spam',
    status: 'open',
    at: 1,
  });
  const review = { reportId, action: 'purge', reason: 'Spam', operationId: randomUUID() };
  assert.deepEqual(await reports.review._handler(s.ctx, review), { reportId, status: 'purged', removed: 1 });
  // The operator's evidence (the report's excerpt) is the one copy kept, as for every purged report.
  assert.deepEqual(secretRows(s), [
    `abuseReports:comment:${s.tables.abuseReports.get(reportId).operationId}`,
  ]);
  const audit = [...s.tables.boardAudit.values()];
  assert.deepEqual(
    audit.map(row => [row.action, row.target]),
    [['purge', `comment:${s.projectId}:${reported.operationId}`]],
  );
  assert.deepEqual(JSON.parse(audit[0].detail), {
    reportId,
    operationId: review.operationId,
    deleted: 1,
    done: true,
  });
  const events = s.tables.projectWorkEvents.size;
  assert.deepEqual(await reports.review._handler(s.ctx, review), { reportId, status: 'purged', removed: 1 });
  assert.equal(s.tables.boardAudit.size, 1, 'a retried review writes no second audit row');
  assert.equal(s.tables.projectWorkEvents.size, events, 'and appends no Work row');
  // A later review of the same report does not lose the first one's receipt.
  const dismiss = { reportId, action: 'dismiss', reason: 'Handled', operationId: randomUUID() };
  assert.equal((await reports.review._handler(s.ctx, dismiss)).status, 'dismissed');
  assert.deepEqual(await reports.review._handler(s.ctx, review), { reportId, status: 'purged', removed: 1 });
  assert.equal(s.tables.boardAudit.size, 2, 'a retry of the first review after a later one writes nothing');
  assert.equal(s.tables.abuseReports.get(reportId).status, 'dismissed', 'and keeps the latest outcome');
  await assert.rejects(
    reports.review._handler(s.ctx, { ...review, action: 'dismiss' }),
    code('WORK_OPERATION_CHANGED'),
  );
});

/** R2 for journal segments, in memory: every request is listed. */
function segmentStorage(t) {
  const objects = new Map(),
    requests = [],
    refused = { deletes: 0 };
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
    const key = path.split('/').at(-1),
      method = init?.method ?? 'GET';
    requests.push({ key, method });
    if (method === 'PUT') objects.set(key, Buffer.from(init.body));
    if (method === 'DELETE' && refused.deletes > 0) {
      refused.deletes--;
      return new Response(null, { status: 403 });
    }
    if (method === 'DELETE') objects.delete(key);
    if (method !== 'GET') return new Response(null, { status: method === 'PUT' ? 200 : 204 });
    return objects.has(key) ? new Response(objects.get(key)) : new Response(null, { status: 404 });
  });
  return { objects, requests, refused };
}

/** The comment's Work row moved to an R2 journal segment, as rows archived before comments stayed live are. */
async function archiveRow(s, r2, operationId) {
  const row = [...s.tables.projectHostedRecordBodies.values()].find(item => item.operationId === operationId);
  const segment = {
    protocol: 1,
    kind: 'forge-journal-segment',
    projectId: s.projectId,
    scope: 'events',
    from: row.revision,
    through: row.revision,
    tables: { projectHostedRecordBodies: [canonicalPayload(structuredClone(row))] },
  };
  const text = journalSegmentText(segment);
  const { pointer, body } = encodeArchiveBytes(text, row.revision, journalTablePins(segment.tables));
  r2.objects.set(pointer.sha256, body);
  await s.ctx.db.insert('projectJournalSegments', {
    projectId: s.projectId,
    scope: 'events',
    from: row.revision,
    through: row.revision,
    key: pointer.sha256,
    category: 'events',
    value: canonicalPayload({ scope: 'events', from: row.revision, through: row.revision, pointer }),
  });
  await s.ctx.db.patch(row._id, {
    command: undefined,
    journalSegment: '1',
    journalCommand: canonicalPayload({ action: 'comment-planning-item' }),
  });
  return row._id;
}

/** The test context with the archived purge's and the archived journal read's internal calls routed to their
 * handlers; every other call goes to the fixture's own. */
function routedCtx(s, before) {
  const route = kind => async (ref, args) => {
    const [module, name] = getFunctionName(ref).split(':');
    await before?.(`${module}:${name}`);
    return routed[module]
      ? routed[module][name]._handler(kind === 'runAction' ? ctx : s.ctx, args)
      : s.ctx[kind](ref, args);
  };
  const ctx = {
    ...s.ctx,
    runQuery: route('runQuery'),
    runMutation: route('runMutation'),
    runAction: route('runAction'),
  };
  return ctx;
}

/** Run the scheduled archived purges as the scheduler would. */
async function runScheduled(s, before) {
  const ctx = routedCtx(s, before);
  const results = [],
    tasks = [];
  for (
    let task;
    (task = s.scheduled.find(x => getFunctionName(x.fn) === 'projectCommentPurgeArchive:run'));
  ) {
    s.scheduled.splice(s.scheduled.indexOf(task), 1);
    tasks.push(task);
    results.push(await routed.projectCommentPurgeArchive.run._handler(ctx, task.args));
    assert.ok(results.length <= 4, 'the purge finishes in a few runs');
  }
  return { results, tasks };
}

/** A primary-writer project whose reported comment's row is archived, an open report on it, and its purge review. */
async function archivedReport(t, options = {}) {
  const fixture = await commented(t, { primary: true, ...options });
  const { s, itemId, reported } = fixture;
  const r2 = segmentStorage(t);
  const rowId = await archiveRow(s, r2, reported.operationId);
  const [archivedKey] = r2.objects.keys();
  s.tables.abuseReports ??= new Map();
  s.tables.boardAudit ??= new Map();
  s.tables.abuseReports.set('report-1', {
    _id: 'report-1',
    _creationTime: 1,
    operationId: randomUUID(),
    reporter: 'reporter',
    kind: 'comment',
    projectId: s.projectId,
    itemId,
    targetId: reported.operationId,
    subject: 'owner',
    excerpt: 'Spam',
    reason: 'Spam',
    status: 'open',
    at: 1,
  });
  const review = { reportId: 'report-1', action: 'purge', reason: 'Spam', operationId: randomUUID() };
  return { ...fixture, r2, rowId, archivedKey, review };
}
const auditDetail = s => JSON.parse([...s.tables.boardAudit.values()].at(-1).detail);

test('an archived comment row: the review schedules the purge, which reads the segment, purges every live copy, rewrites only that segment, and marks the audit row done; a retry changes nothing', async t => {
  const { s, itemId, reported, r2, rowId, archivedKey, review } = await archivedReport(t);
  assert.equal(
    await purge(s, itemId, reported.operationId).catch(error => error.data?.code ?? error.code),
    'BAD_ARGUMENT',
    'the direct purge sends an archived row to the action',
  );
  assert.deepEqual(await reports.review._handler(s.ctx, review), {
    reportId: 'report-1',
    status: 'purged',
    removed: 0,
  });
  const [audit] = [...s.tables.boardAudit.values()];
  assert.equal(JSON.parse(audit.detail).done, false, 'the audit row says the purge is running');
  const meter = meterWorkIO(s.ctx, s.tables);
  let ran;
  const cost = await meter.cost(async () => {
    ran = await runScheduled(s);
  });
  meter.restore();
  assert.deepEqual(ran.results, ['done']);
  t.diagnostic(`archived comment purge: ${JSON.stringify(cost)}`);
  assert.ok(cost.writeDocuments <= 40, `writes stay small (${cost.writeDocuments})`);
  assert.ok(cost.readDocuments <= 160, `reads stay small (${cost.readDocuments})`);
  assert.deepEqual(secretRows(s), [], 'no table holds the words');
  assert.equal(
    [...r2.objects.values()].some(bytes => gunzipSync(bytes).toString().includes(SECRET)),
    false,
    'no R2 segment holds the words',
  );
  assert.equal(r2.objects.has(archivedKey), false, 'the old segment object is deleted');
  assert.deepEqual(
    r2.requests.map(row => row.method),
    ['GET', 'GET', 'GET', 'PUT', 'GET', 'DELETE'],
    'a read to find the command, then the sweep: read, absence check, put, read-back, old object delete',
  );
  const live = s.tables.projectHostedRecordBodies.get(rowId);
  assert.ok(live.purged, 'the live row is purged');
  assert.equal(JSON.parse(s.tables.boardAudit.get(audit._id).detail).done, true, 'and the audit row is done');
  const entry = s.tables.hostedProjects
    .get(s.projectId)
    .itemPurges.find(item => item.commentId === reported.operationId);
  assert.ok(entry.purgedAt, 'the purge entry is finished');
  assert.equal(entry.segmentSweep, undefined, 'and keeps no sweep state');
  assert.equal(
    await planningPurge.status._handler(s.ctx, { projectId: s.projectId, operationId: entry.operationId }),
    null,
    'the Item purge executor never takes a comment purge as its own',
  );
  const data = JSON.parse(await readHosted(routedCtx(s), { projectId: s.projectId })).data;
  assert.equal(JSON.stringify(data).includes(SECRET), false, 'a load reads the rewritten segment');
  assert.equal(
    data.planningItems.some(row => row.id === itemId),
    true,
    'the Item stays (this is not an Item purge)',
  );
  assert.equal(comments(data, itemId).find(row => row.id === reported.operationId).text, 'Deleted comment');
  // A retried review and a re-run of the action change nothing and reach R2 not at all.
  const tables = () =>
    JSON.stringify(Object.fromEntries(Object.entries(s.tables).map(([k, v]) => [k, [...v]])));
  const before = tables();
  assert.deepEqual(await reports.review._handler(s.ctx, review), {
    reportId: 'report-1',
    status: 'purged',
    removed: 0,
  });
  assert.equal(
    s.scheduled.filter(x => getFunctionName(x.fn) === 'projectCommentPurgeArchive:run').length,
    0,
    'a retried review schedules no purge',
  );
  r2.requests.length = 0;
  s.scheduled.push(ran.tasks[0]);
  assert.deepEqual((await runScheduled(s)).results, ['done']);
  assert.deepEqual(r2.requests, []);
  assert.equal(tables(), before);
});

test('an archived comment purge whose old segment object refuses deletion stays running, retries, and is done only once the object is gone', async t => {
  const { s, r2, archivedKey, review } = await archivedReport(t);
  await reports.review._handler(s.ctx, review);
  r2.refused.deletes = 1;
  const { results } = await runScheduled(s);
  assert.deepEqual(
    results,
    ['continues', 'done'],
    'the refused delete retries; the retry finishes the sweep',
  );
  assert.equal(r2.objects.has(archivedKey), false);
  assert.equal(auditDetail(s).done, true);
  assert.deepEqual(secretRows(s), []);
});

test('an archived comment purge refused before anything is written reopens the report, keeps the failure on the audit row, and a retry of the review runs again', async t => {
  const { s, reported, review } = await archivedReport(t);
  const row = [...s.tables.projectHostedRecordBodies.values()].find(
    item => item.operationId === reported.operationId,
  );
  // The comment is in the base checkpoint: the selected generation starts after it.
  for (const item of s.tables.projectWorkGenerations.values()) item.initialRevision = row.revision;
  await reports.review._handler(s.ctx, review);
  const words = secretRows(s).length;
  assert.deepEqual((await runScheduled(s)).results, ['failed']);
  assert.equal(secretRows(s).length, words, 'nothing was purged');
  assert.equal(auditDetail(s).failed, 'BAD_ARGUMENT');
  assert.equal(auditDetail(s).done, false);
  const report = s.tables.abuseReports.get('report-1');
  assert.equal(report.status, 'open', 'the report is back in the open queue');
  assert.equal(report.reviews.length, 0, 'and its receipt is dropped');
  await reports.review._handler(s.ctx, review);
  assert.equal(
    s.scheduled.filter(x => getFunctionName(x.fn) === 'projectCommentPurgeArchive:run').length,
    1,
    'a retry of the same review runs it anew',
  );
});

test('a decision line edited since (the marker kept) is still found and emptied in the current body', async t => {
  const { s, itemId, reported } = await commented(t, { decision: true, laterPut: false });
  const current = (await s.read()).data.planningItems.filter(row => row.id === itemId).at(-1);
  await s.send({
    ...s.item({ itemId, expectedVersion: current.version }),
    body: current.body.replace(`Spam ${SECRET}`, `**Spam ${SECRET}**`),
  });
  assert.equal(await purge(s, itemId, reported.operationId), 1);
  const after = (await s.read()).data.planningItems.filter(row => row.id === itemId).at(-1);
  assert.equal(after.reason, commentPurge.DECISION_EDIT_REASON);
  assert.equal(after.body.includes(SECRET), false);
  assert.match(after.body, /Deleted comment \(comment [0-9a-f]{8}\)/);
});

test('a decision whose derived Item version is only in the journal archive is refused with nothing written', async t => {
  const { s, itemId, reported } = await commented(t, { decision: true, laterPut: false, records: true });
  const derived = [...s.tables.projectHostedRecords.values()].find(
    row => row.kind === 'issue' && s.tables.projectHostedRecordBodies.get(row.bodyId)?.value.includes(SECRET),
  );
  assert.ok(derived && derived.inline === undefined, 'the fixture stores the derived version as a body');
  s.tables.projectHostedRecordBodies.delete(derived.bodyId);
  const words = secretRows(s).length;
  await assert.rejects(purge(s, itemId, reported.operationId), error => {
    assert.equal(error.data?.code ?? error.code, 'BAD_ARGUMENT');
    assert.match(error.message, /journal archive/);
    return true;
  });
  assert.equal(secretRows(s).length, words, 'nothing was purged');
});

test('index copies a rebuild makes from the whole archived row while its segment is rewritten are removed by the last step', async t => {
  const { s, review } = await archivedReport(t);
  // What a rebuild that read the archived segment before its rewrite writes: the comment's index records, whole.
  const copies = ['projectPlanningRecords', 'projectWorkRecords', 'projectWorkDataRecords'].flatMap(table =>
    [...(s.tables[table]?.values() ?? [])]
      .filter(row => JSON.stringify(row).includes(SECRET))
      .map(row => [table, structuredClone(row)]),
  );
  assert.ok(copies.length > 0);
  await reports.review._handler(s.ctx, review);
  let planted = false;
  const { results } = await runScheduled(s, async name => {
    if (name !== 'projectPlanningPurgeSegmentRun:run' || planted) return;
    planted = true;
    for (const [table, row] of copies) s.tables[table].set(row._id, structuredClone(row));
  });
  assert.equal(planted, true);
  assert.deepEqual(results, ['done']);
  assert.deepEqual(secretRows(s), [], 'the last step settled every live copy');
});
