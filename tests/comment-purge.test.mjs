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

const SECRET = 'wombat-comment-purge-fixture';
const code = expected => error => (error.data?.code ?? error.code) === expected;
const { purgeComment } = await import(moduleUrl('../convex/projectCommentPurge.ts'));
const reports = await import(moduleUrl('../convex/abuseReports.ts'));
const workStore = await import(moduleUrl('../convex/projectWorkStore.ts'));
const workIndex = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const hostedRecords = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const artifactStorage = await import(moduleUrl('../convex/artifactStorage.ts'));
const { ensure } = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));

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
async function commented(t, { records = false, primary = false, decision = false } = {}) {
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
  await s.send({
    ...s.item({ itemId: item.itemId, expectedVersion: decision ? 2 : 1 }),
    title: 'Kept title 2',
  });
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
  purgeComment(s.ctx, { projectId: s.projectId, itemId, commentId, operationId });
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

test('a decision comment and a purge while a Work index builds are refused with nothing written', async t => {
  const decided = await commented(t, { decision: true });
  const before = JSON.stringify(
    Object.fromEntries(Object.entries(decided.s.tables).map(([k, v]) => [k, [...v]])),
  );
  await assert.rejects(purge(decided.s, decided.itemId, decided.reported.operationId), error => {
    assert.equal(error.data?.code ?? error.code, 'BAD_ARGUMENT');
    assert.match(error.message, /decision comment/);
    return true;
  });
  assert.equal(
    JSON.stringify(Object.fromEntries(Object.entries(decided.s.tables).map(([k, v]) => [k, [...v]]))),
    before,
  );
  const { s, itemId, reported } = await commented(t);
  const generation = [...s.tables.projectWorkGenerations.values()][0];
  s.tables.projectWorkGenerations.set('building', { ...generation, _id: 'building', status: 'building' });
  await assert.rejects(purge(s, itemId, reported.operationId), code('WORK_STALE'));
  assert.equal(secretRows(s).length > 0, true, 'nothing was purged');
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
