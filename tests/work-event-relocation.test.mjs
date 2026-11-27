// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { metadataRequest } from '../dist/work-metadata.js';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { digest } from '../dist/state/hash.js';
import { purgedFactsDigest, purgedFactsText, redactPlanningWrite } from '../dist/work-intent-types.js';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';

const { page, retireWindows } = await import(moduleUrl('../convex/projectWorkEventMigration.ts'));
const { findWorkEvent, retainWorkEvent } = await import(moduleUrl('../convex/projectWorkEventStore.ts'));
const { retainedEventPage } = await import(moduleUrl('../convex/projectWorkEventPage.ts'));

function seeded() {
  const fixture = state([], { keysetPaging: true });
  const projectId = 'project',
    owner = 'owner';
  const project = {
    _id: projectId,
    _creationTime: 9,
    owner,
    key: randomUUID(),
    name: 'Relocation',
    revision: 1,
    currentBackup: null,
  };
  fixture.tables.hostedProjects.set(projectId, project);
  function event(revision) {
    const command = { action: 'note', kind: 'comment', intentId: randomUUID(), text: 'A stored Work note.' };
    return {
      projectId,
      operationId: randomUUID(),
      request: metadataRequest(command),
      previousRevision: revision - 1,
      revision,
      actor: owner,
      at: '2026-11-26T10:00:00Z',
      command: JSON.stringify(command),
    };
  }
  return { ...fixture, project, projectId, event };
}

const logical = ({ _id, _creationTime, ...event }) => event;
const applyPin = (range, expectedDigest) => ({
  expectedDigest,
  operationId: digest(canonicalPayload({ ...range, expectedDigest })),
});

test('relocation preserves the logical event page and assigns its canonical body a new id', async () => {
  const { ctx, project, projectId, tables, event } = seeded();
  const first = { ...event(1), _id: 'old-event', _creationTime: 100, baseBackupId: 'pinned-backup' };
  tables.projectWorkEvents.set(first._id, first);
  const { previousRevision: _previousRevision, ...next } = event(2);
  const second = await retainWorkEvent(ctx, next);
  const request = { initialRevision: 0, revision: 2, paginationOpts: { numItems: 2, cursor: null } };
  const before = await retainedEventPage(ctx, project, request);
  assert.deepEqual(before.page, [first, second]);
  const scan = { projectId, after: 0, through: 2 };
  const dry = await page._handler(ctx, scan);
  assert.equal(dry.scanned, 1);
  assert.equal(dry.moved, 0);
  assert.equal(tables.projectWorkEvents.size, 1);
  const pinned = { ...scan, through: dry.after, expectedDigest: dry.digest };
  const { expectedDigest, ...range } = pinned;
  const apply = { expectedDigest, operationId: digest(canonicalPayload(pinned)) };
  assert.equal((await page._handler(ctx, { ...range, apply })).moved, 1);
  assert.equal((await page._handler(ctx, { ...range, apply })).moved, 0);
  assert.equal((await page._handler(ctx, scan)).scanned, 0);
  const moved = await findWorkEvent(ctx, projectId, first.operationId);
  assert.notEqual(moved._id, first._id);
  assert.deepEqual(logical(moved), logical(first));
  assert.deepEqual(
    (await retainedEventPage(ctx, project, request)).page.map(logical),
    before.page.map(logical),
  );
  assert.equal(tables.hostedProjects.get(projectId).journalEventRewriteRevision, 1);
});

test('relocation keeps the purge witness and native acceptance provenance', async () => {
  const { ctx, project, projectId, tables, event } = seeded();
  const source = event(1);
  const command = JSON.parse(source.command);
  const purgeOperationId = randomUUID();
  const purge = {
    action: 'purge-planning-item',
    itemId: command.intentId,
    operationId: purgeOperationId,
    kind: 'issue',
    expectedVersion: 2,
    deletedAt: source.at,
    rows: [[source.operationId, purgedFactsDigest(redactPlanningWrite(command))]],
  };
  const accept = {
    action: 'accept-hosted-channel',
    channel: 'main',
    viewId: randomUUID(),
    head: 'a'.repeat(64),
    previousId: null,
    archiveSha256: 'b'.repeat(64),
  };
  for (const row of [
    { ...source, command: purgedFactsText(command), purged: purgeOperationId },
    {
      ...event(2),
      operationId: purgeOperationId,
      command: JSON.stringify(purge),
      request: metadataRequest(purge),
    },
    {
      ...event(3),
      command: JSON.stringify(accept),
      request: metadataRequest(accept),
      automatic: { actor: 'owner', summary: 'Accepted the pinned Candidate', undo: 'restore previous head' },
    },
  ]) {
    const _id = 'old-' + row.revision;
    tables.projectWorkEvents.set(_id, { ...row, _id, _creationTime: row.revision + 10 });
  }
  const request = { initialRevision: 0, revision: 3, paginationOpts: { numItems: 3, cursor: null } };
  const before = await retainedEventPage(ctx, project, request);
  const range = { projectId, after: 0, through: 3 };
  const dry = await page._handler(ctx, range);
  const expectedDigest = dry.digest;
  const operationId = digest(canonicalPayload({ ...range, expectedDigest }));
  const moved = await page._handler(ctx, { ...range, apply: { expectedDigest, operationId } });
  assert.equal(moved.moved, 3);
  assert.deepEqual(
    (await retainedEventPage(ctx, project, request)).page.map(logical),
    before.page.map(logical),
  );
  assert.equal(
    [...tables.projectHostedRecordBodies.values()].filter(row => row.purged)[0].command,
    undefined,
  );
});

test('relocation rejects a purge marker without its recorded command and leaves the original row', async () => {
  const { ctx, projectId, tables, event } = seeded();
  const old = { ...event(1), _id: 'old-event', _creationTime: 100, purged: randomUUID() };
  old.command = JSON.stringify({ ...JSON.parse(old.command), text: '[purged]' });
  tables.projectWorkEvents.set(old._id, old);
  await assert.rejects(
    page._handler(ctx, { projectId, after: 0, through: 1 }),
    error => error.code === 'INVALID_WORK_JOURNAL',
  );
  assert.deepEqual(tables.projectWorkEvents.get(old._id), old);
  assert.equal(tables.projectHostedRecordBodies?.size ?? 0, 0);
});

test('relocation refuses an active purge, an indexed collision, and a changed dry-run pin', async () => {
  const { ctx, project, projectId, tables, event } = seeded();
  const row = { ...event(1), _id: 'original', _creationTime: 10 };
  tables.projectWorkEvents.set(row._id, row);
  const range = { projectId, after: 0, through: 1 };
  project.itemPurges = [{}];
  await assert.rejects(page._handler(ctx, range), error => error.code === 'WORK_STALE');
  delete project.itemPurges;
  const dry = await page._handler(ctx, range);
  const changed = { ...row, actor: 'another recorded actor' };
  tables.projectWorkEvents.set(row._id, changed);
  await assert.rejects(
    page._handler(ctx, { ...range, apply: applyPin(range, dry.digest) }),
    error => error.code === 'WORK_STALE',
  );
  assert.deepEqual(tables.projectWorkEvents.get(row._id), changed);

  const { _id, _creationTime, previousRevision, ...canonical } = event(1);
  const incoming = await retainWorkEvent(ctx, canonical);
  await assert.rejects(page._handler(ctx, range), error => error.code === 'INVALID_WORK_JOURNAL');
  assert.deepEqual(await findWorkEvent(ctx, projectId, incoming.operationId), incoming);
});

test('the historical and current event indexes share one row limit across old epoch boundaries', async () => {
  const { ctx, project, tables, event } = seeded();
  project.workStoreEventWindows = [
    { revision: 1, storeFirst: true },
    { revision: 2, storeFirst: false },
  ];
  for (let revision = 1; revision <= 5; revision++) {
    if (revision % 2 === 1) {
      const id = 'legacy-' + revision;
      tables.projectWorkEvents.set(id, { ...event(revision), _id: id, _creationTime: revision });
    } else {
      const { previousRevision, ...canonical } = event(revision);
      await retainWorkEvent(ctx, canonical);
    }
  }
  let cursor = null;
  const revisions = [];
  for (let i = 0; i < 3; i++) {
    const batch = await retainedEventPage(ctx, project, {
      initialRevision: 0,
      revision: 5,
      paginationOpts: { cursor, numItems: 5, maximumRowsRead: 2 },
    });
    assert.ok(batch.page.length <= 2);
    revisions.push(...batch.page.map(row => row.revision));
    assert.equal(batch.isDone, i === 2);
    cursor = batch.continueCursor;
  }
  assert.deepEqual(revisions, [1, 2, 3, 4, 5]);
});

test('one relocation page verifies at most four distinct purge witnesses and resumes the fifth', async () => {
  const { ctx, projectId, tables, event } = seeded();
  for (let n = 1; n <= 5; n++) {
    const source = event(n);
    const command = JSON.parse(source.command);
    const witness = event(n + 5);
    const purge = {
      action: 'purge-planning-item',
      operationId: witness.operationId,
      itemId: command.intentId,
      kind: 'issue',
      expectedVersion: 1,
      deletedAt: source.at,
      rows: [[source.operationId, purgedFactsDigest(redactPlanningWrite(command))]],
    };
    tables.projectWorkEvents.set('source-' + n, {
      ...source,
      _id: 'source-' + n,
      _creationTime: n,
      purged: witness.operationId,
      command: purgedFactsText(command),
    });
    tables.projectWorkEvents.set('witness-' + n, {
      ...witness,
      _id: 'witness-' + n,
      _creationTime: n + 5,
      command: JSON.stringify(purge),
      request: metadataRequest(purge),
    });
  }
  const next = await page._handler(ctx, { projectId, after: 0, through: 10 });
  assert.equal(next.after, 4);
  assert.equal(next.scanned, 4);
  assert.equal(next.done, false);
  assert.equal((await page._handler(ctx, { projectId, after: next.after, through: 10 })).scanned, 6);
});

test('person Work and audit keep the operation’s author after physical relocation', async () => {
  const { ctx, projectId, tables, event } = seeded();
  const id = randomUUID();
  const original = event(1);
  const command = {
    action: 'put-planning-item',
    operationId: original.operationId,
    itemId: id,
    expectedVersion: 0,
    title: 'Audited Item',
    kind: 'issue',
    status: 'open',
  };
  const row = {
    ...original,
    _id: 'legacy-op',
    _creationTime: 1,
    command: JSON.stringify(command),
    request: metadataRequest(command),
  };
  tables.projectWorkEvents.set(row._id, row);
  const { planningCommand } = await import(moduleUrl('../convex/personWork.ts'));
  const { loadVersionSnapshot } = await import(moduleUrl('../convex/projectPlanningAudit.ts'));
  const { planningHistoryBudget } = await import(moduleUrl('../convex/projectPlanningHistory.ts'));
  const item = { id, version: 1, operationId: original.operationId };
  const version = { bodyId: 'missing-old-body', inline: JSON.stringify({ item }) };
  const read = () => loadVersionSnapshot(ctx, projectId, null, version, planningHistoryBudget());
  assert.deepEqual(await planningCommand(ctx, projectId, row.operationId), command);
  assert.deepEqual(await read(), { item, actor: 'owner' });
  const range = { projectId, after: 0, through: 1 };
  const dry = await page._handler(ctx, range);
  await page._handler(ctx, { ...range, apply: applyPin(range, dry.digest) });
  assert.deepEqual(await planningCommand(ctx, projectId, row.operationId), command);
  assert.deepEqual(await read(), { item, actor: 'owner' });
});

test('window retirement refuses while original events remain and is idempotent once empty', async () => {
  const { ctx, project, tables, event } = seeded();
  project.workStoreCutoverRevision = 1;
  project.workStoreEventWindows = [{ revision: 1, storeFirst: true }];
  tables.projectWorkEvents.set('old', { ...event(1), _id: 'old', _creationTime: 1 });
  await assert.rejects(
    retireWindows._handler(ctx, { cursor: null, apply: true }),
    error => error.code === 'WORK_STALE',
  );
  tables.projectWorkEvents.delete('old');
  assert.equal((await retireWindows._handler(ctx, { cursor: null, apply: false })).found, 1);
  assert.equal((await retireWindows._handler(ctx, { cursor: null, apply: true })).changed, 1);
  assert.equal((await retireWindows._handler(ctx, { cursor: null, apply: true })).found, 0);
});
