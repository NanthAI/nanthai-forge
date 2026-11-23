// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { state } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { recoveryTables, hostedRecoveryPageSchema } from '../dist/recovery-hosted-protocol.js';
const recovery = await import(moduleUrl('../convex/projectRecovery.ts'));
const hosted = await import(moduleUrl('../convex/projectRecoveryHosted.ts'));
function fixture() {
  const f = state([], { keysetPaging: true });
  for (const table of [...recoveryTables, 'projectHostedChannels']) f.tables[table] ??= new Map();
  f.tables.hostedProjects.set('project', {
    _id: 'project',
    owner: 'owner',
    key: randomUUID(),
    name: 'Synthetic',
    currentBackup: 'backup',
    sourceAuthority: { mode: 'server', epoch: 3 },
    work: { backupId: 'backup', initialRevision: 1, revision: 1 },
  });
  f.tables.projectBackups.set('backup', {
    _id: 'backup',
    projectId: 'project',
    status: 'stored',
    transport: 'objects',
    digest: 'a'.repeat(64),
    size: 100,
    validatedClosure: 1,
    preview: { format: 'native', manifestDigest: 'b'.repeat(64) },
  });
  const main = {
    schema: 2,
    projectId: 'project',
    channel: 'main',
    head: 'c'.repeat(64),
    snapshotId: 'seed',
    sourceRevision: 0,
    authority: { mode: 'server', epoch: 3 },
    receipt: { id: randomUUID(), kind: 'native', previousHead: null, previousReceiptId: null },
  };
  f.tables.projectHostedChannels.set('channel', {
    _id: 'channel',
    projectId: 'project',
    name: 'main',
    operationId: randomUUID(),
    selection: JSON.stringify(main),
  });
  const prepare = async () =>
    JSON.parse(await recovery.prepare._handler(f.ctx, { projectId: 'project', operationId: randomUUID() }));
  return {
    ...f,
    main,
    prepare,
    page: async (selection, table, cursor = null, projectId = 'project') =>
      hostedRecoveryPageSchema.parse(
        JSON.parse(
          await hosted.page._handler(f.ctx, {
            projectId,
            selection: JSON.stringify(selection),
            table,
            cursor,
          }),
        ),
      ),
  };
}

test('all hosted recovery tables use project-prefixed indexes and bounded resumable pages, with no hosted writes', async () => {
  const f = fixture(),
    { selection } = await f.prepare();
  assert.deepEqual(selection.hostedMain, f.main);
  for (const table of recoveryTables) {
    for (let i = 0; i < 133; i++)
      f.tables[table].set(`${table}-${i}`, {
        _id: `${table}-${i}`,
        _creationTime: i,
        projectId: 'project',
        revision: 133 - i,
        kind: String(i % 3),
        key: String(133 - i),
        value: `exact-${i}`,
      });
    f.tables[table].set('foreign', {
      _id: 'foreign',
      _creationTime: 0,
      projectId: 'other',
      value: 'private',
    });
  }
  const before = structuredClone(f.tables);
  for (const table of recoveryTables) {
    let cursor = null,
      count = 0;
    const ids = new Set();
    do {
      const result = await f.page(selection, table, cursor);
      assert(result.rows.length <= 64);
      assert(result.rows.every(text => JSON.parse(text).projectId === 'project'));
      for (const text of result.rows) ids.add(JSON.parse(text)._id);
      count += result.rows.length;
      cursor = result.cursor;
    } while (cursor);
    assert.equal(count, 133, table);
    assert.equal(ids.size, 133, `${table}: every identity survives changed suffix ordering`);
  }
  assert.deepEqual(f.tables, before, 'paging does not mutate hosted data');
});

for (const actor of [null, 'reader', 'contributor'])
  test(`recovery pages require current owner authority (${actor})`, async () => {
    const f = fixture(),
      { selection } = await f.prepare();
    f.caller(actor);
    await assert.rejects(f.page(selection, recoveryTables[0]), e => e.data.code === 'PROJECT_UNAVAILABLE');
  });

for (const change of ['main', 'authority', 'journal', 'project'])
  test(`resumed pages reject changed ${change} pins`, async () => {
    const f = fixture(),
      { selection } = await f.prepare();
    if (change === 'main') {
      f.main.head = 'd'.repeat(64);
      f.tables.projectHostedChannels.get('channel').selection = JSON.stringify(f.main);
    }
    if (change === 'authority') f.tables.hostedProjects.get('project').sourceAuthority.epoch++;
    if (change === 'journal') f.tables.hostedProjects.get('project').work.revision++;
    if (change === 'project') selection.projectId = 'other';
    await assert.rejects(
      f.page(selection, 'projectHostedAcceptances'),
      e => e.data.code === (change === 'authority' ? 'SOURCE_AUTHORITY_CHANGED' : 'WORK_STALE'),
    );
  });

test('revocation is enforced again on every continued page', async () => {
  const f = fixture(),
    { selection } = await f.prepare();
  await f.page(selection, 'projectHostedAcceptances');
  const credentialId = randomUUID();
  f.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: credentialId });
  f.tables.cliCredentials.set('device', {
    credentialId,
    owner: 'owner',
    scope: 'cli',
    revoked: true,
    expiresAt: Date.now() + 10000,
  });
  await assert.rejects(f.page(selection, 'projectHostedAcceptances'), e => e.data.code === 'AUTH_REVOKED');
});

test('Done-when5: opted-in State recovery pages carry exact retained roots without changing canonical rows', async () => {
  const f = fixture(),
    { selection } = await f.prepare();
  const root = { sha256: 'd'.repeat(64), size: 321 };
  const state = {
    _id: 'registered',
    projectId: 'project',
    head: f.main.head,
    size: 123,
    input: 'i',
    jobId: 'j',
    output: 'o',
  };
  f.tables.projectHostedStates.set(state._id, state);
  f.tables.projectObjects.set('state', {
    _id: 'state',
    projectId: 'project',
    digest: state.head,
    size: state.size,
    nonce: '',
    removed: false,
    sourceReferenced: true,
    statePhysical: root,
  });
  const legacy = await f.page(selection, 'projectHostedStates');
  assert.equal(legacy.physicalRoots, undefined);
  const page = JSON.parse(
    await hosted.page._handler(f.ctx, {
      projectId: 'project',
      selection: JSON.stringify(selection),
      physicalProtocol: 1,
      table: 'projectHostedStates',
      cursor: null,
    }),
  );
  assert.deepEqual(page.rows, legacy.rows);
  assert.deepEqual(page.physicalRoots, [{ state: { sha256: state.head, size: state.size }, root }]);
  f.tables.projectObjects.get('state').projectId = 'other';
  const absent = JSON.parse(
    await hosted.page._handler(f.ctx, {
      projectId: 'project',
      selection: JSON.stringify(selection),
      physicalProtocol: 1,
      table: 'projectHostedStates',
      cursor: null,
    }),
  );
  assert.deepEqual(absent.physicalRoots, [], 'another project never supplies an archival root');
});

test('Item 8c50ce13: a receipt that references its stored message leaves recovery as the inline receipt', async () => {
  const f = fixture(),
    { selection } = await f.prepare();
  f.tables.projectHostedLandingBodies ??= new Map();
  f.tables.projectHostedLandingBodies.set('projectHostedLandingBodies-1', {
    _id: 'projectHostedLandingBodies-1',
    value: 'Stored subject\n\nCo-Authored-By: Synthetic <noreply@openai.com>',
    messageProjectId: 'project',
  });
  const inline = JSON.stringify({ id: 'inline', message: 'Inline subject' });
  for (const table of ['projectHostedAcceptances', 'projectHostedAcceptanceEvents']) {
    for (const [index, value] of [
      inline,
      JSON.stringify({ id: 'stored', messageRef: 'projectHostedLandingBodies-1' }),
    ].entries())
      f.tables[table].set(`${table}-${index}`, {
        _id: `${table}-${index}`,
        _creationTime: index,
        projectId: 'project',
        receiptId: `receipt-${index}`,
        sequence: index + 1,
        value,
      });
    const rows = (await f.page(selection, table)).rows.map(row => JSON.parse(row));
    assert.equal(rows[0].value, inline, 'inline receipts keep their exact bytes');
    assert.deepEqual(JSON.parse(rows[1].value), {
      id: 'stored',
      message: 'Stored subject\n\nCo-Authored-By: Synthetic <noreply@openai.com>',
    });
  }
});

test('Item 8c50ce13: expanded receipt pages keep the 128 KiB budget and resume at the first row that did not fit', async () => {
  const f = fixture(),
    { selection } = await f.prepare();
  const message = '"'.repeat(1024);
  f.tables.projectHostedLandingBodies ??= new Map();
  f.tables.projectHostedLandingBodies.set('projectHostedLandingBodies-1', {
    _id: 'projectHostedLandingBodies-1',
    value: message,
    messageProjectId: 'project',
  });
  const table = 'projectHostedAcceptances';
  for (let index = 0; index < 64; index++)
    f.tables[table].set(`${table}-${index}`, {
      _id: `${table}-${index}`,
      _creationTime: index,
      projectId: 'project',
      receiptId: `receipt-${index}`,
      sequence: index + 1,
      value: JSON.stringify({ id: `stored-${index}`, messageRef: 'projectHostedLandingBodies-1' }),
    });
  const rows = [];
  let cursor = null,
    pages = 0;
  for (;;) {
    const page = await f.page(selection, table, cursor);
    pages++;
    assert(
      page.rows.reduce((sum, row) => sum + Buffer.byteLength(row), 0) <= 128 * 1024,
      'every expanded page fits the transport budget',
    );
    rows.push(...page.rows.map(row => JSON.parse(JSON.parse(row).value)));
    if (page.done) break;
    cursor = page.cursor;
  }
  assert(pages > 1, 'the stored page split after expansion');
  assert.deepEqual(
    rows,
    Array.from({ length: 64 }, (_, index) => ({ id: `stored-${index}`, message })),
    'every receipt leaves once, in order',
  );
});
