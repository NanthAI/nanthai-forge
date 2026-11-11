// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { hostedRecoveryFixture } from './recovery-hosted-fixture.mjs';
import { capsuleMaintenanceFixture } from './landing-capsule-maintenance-fixture.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { encodeLandingCapsule, decodeLandingCapsule } from '../dist/landing-capsule-bytes.js';
import { restoreRecoverySource } from '../dist/recovery-source.js';
import { hostedRecoveryRows } from '../dist/recovery-hosted.js';
import { NativeSource } from '../dist/native-source.js';
import { WorkStore } from '../dist/work-store.js';
const recovery = await import(moduleUrl('../convex/projectRecovery.ts'));
const hosted = await import(moduleUrl('../convex/projectRecoveryHosted.ts'));
const cold = await import(moduleUrl('../convex/projectLandingCapsuleRead.ts'));
const people = await import(moduleUrl('../convex/publicPeople.ts'));
const index = await import(moduleUrl('../convex/projectLandingCapsuleIndex.ts'));
const store = await import(moduleUrl('../convex/projectLandingCapsuleStore.ts'));

async function fixture(t, { privateActor = false } = {}) {
  const h = await capsuleMaintenanceFixture(t);
  const f = await hostedRecoveryFixture(t);
  // Portable fixtures use a symbolic project id; the indexed server fake needs its table-qualified id.
  const qualify = value => {
    if (value === 'project') return 'hostedProjects-syntheticRecovery';
    if (typeof value === 'string' && /^[\[{]/.test(value)) {
      try {
        return canonicalPayload(qualify(JSON.parse(value)));
      } catch {
        return value;
      }
    }
    if (Array.isArray(value)) return value.map(qualify);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, qualify(item)]));
    return value;
  };
  for (const table of Object.keys(f.tables)) f.tables[table] = qualify(f.tables[table]);
  f.selection = qualify(f.selection);
  f.request = qualify(f.request);
  f.acceptedReceipts = qualify(f.acceptedReceipts);
  const s = lanesFixture(),
    projectId = f.selection.projectId;
  for (const [table, rows] of Object.entries(f.tables))
    for (const row of rows) s.tables[table].set(row._id, structuredClone(row));
  s.tables.hostedProjects.set(projectId, {
    _id: projectId,
    _creationTime: 0,
    key: f.selection.ownerId,
    owner: 'owner',
    name: 'Synthetic',
    visibility: 'private',
    currentBackup: null,
    revision: 0,
    sourceAuthority: f.selection.authority,
    work: { backupId: 'backup', revision: f.selection.revision },
  });
  s.tables.projectBackups.set('backup', {
    _id: 'backup',
    _creationTime: 0,
    projectId,
    status: 'stored',
    digest: f.selection.checkpointSha256,
    size: f.selection.checkpointSize,
    preview: { format: 'native', manifestDigest: f.selection.manifestSha256 },
    transport: f.selection.transport,
    validatedClosure: true,
  });
  s.insert('projectHostedChannels', {
    projectId,
    operationId: f.request.operationId,
    name: 'main',
    selection: canonicalPayload(f.selection.hostedMain),
  });
  const submissionId = f.acceptedReceipts[0].submissionId;
  const originalAnchor = JSON.parse([...h.f.tables.projectHostedLandingRequests.values()][0].value);
  if (privateActor) {
    const subject = 'user_syntheticArchiveAuthorAAAA';
    f.tables.projectHostedAcceptancePlans[0].actor = subject;
    s.tables.projectHostedAcceptancePlans.get(f.tables.projectHostedAcceptancePlans[0]._id).actor = subject;
    s.tables.forgeAccounts.set('synthetic-author', {
      _id: 'synthetic-author',
      _creationTime: 0,
      owner: subject,
      handle: 'current-author',
    });
  }
  const tables = Object.fromEntries(
    [
      'projectHostedAcceptanceSnapshots',
      'projectHostedAcceptanceEvents',
      'projectHostedAcceptancePlans',
      'projectHostedAcceptancePages',
    ].map(table => [table, f.tables[table].map(canonicalPayload)]),
  );
  const capsule = {
    protocol: 1,
    projectId,
    submissionId,
    anchor: { ...originalAnchor, projectId, id: submissionId },
    tables,
  };
  const encoded = encodeLandingCapsule(capsule);
  // The same raw server object is used by the public action and privileged byte-exact drill.
  h.objects.set(encoded.pointer.sha256, encoded.body);
  const publish = () => {
    s.insert('projectFinishReadRows', {
      kind: index.capsuleIndexKind,
      projectId,
      sourceId: projectId,
      value: canonicalPayload({ done: true, cursor: null, phase: 'attempts', revision: 1 }),
    });
    s.insert('projectFinishReadRows', {
      kind: store.capsuleKind,
      projectId,
      submissionId,
      sourceId: 'synthetic-request',
      value: canonicalPayload(encoded.pointer),
    });
  };
  const query = (name, args, actor = 'owner') => {
    const functions = { 'projectRecoveryHosted:page': hosted.page, 'publicPeople:resolve': people.resolve };
    assert(functions[name], name);
    return s.call('capsuleRecoveryQuery', functions[name], args, actor);
  };
  const action = (args, actor = 'owner') =>
    cold.history._handler(
      {
        auth: { getUserIdentity: async () => ({ subject: actor }) },
        runQuery: (ref, input) => query(getFunctionName(ref), input, actor),
      },
      { projectId, query: 'projectRecoveryHosted:page', request: canonicalPayload(args) },
    );
  f.transport.prepare = async () =>
    JSON.parse(
      await s.call('capsuleRecoveryPrepare', recovery.prepare, {
        projectId,
        operationId: f.request.operationId,
        capsuleProtocol: 1,
      }),
    );
  f.transport.hostedPage = async (selection, table, cursor) => {
    const args = { projectId, selection: canonicalPayload(selection), table, cursor, capsuleProtocol: 1 };
    const first = await query('projectRecoveryHosted:page', args);
    return JSON.parse(JSON.parse(first).landingCapsule ? await action(args) : first);
  };
  return { f, h, s, capsule, encoded, publish, action, query };
}

test('S1 recovery drill restores capsule-only acceptance history and hosted source through the production server action', async t => {
  const h = await fixture(t);
  h.publish();
  const { selection } = await h.f.transport.prepare();
  for (const table of Object.keys(h.capsule.tables)) h.s.tables[table].clear();
  const directory = `${h.f.target}-capsule-stage`,
    stage = join(directory, 'snapshot');
  mkdirSync(directory, { recursive: true });
  const coverage = await restoreRecoverySource(directory, stage, h.f.request, selection, h.f.transport);
  renameSync(stage, h.f.target);
  const source = new NativeSource(h.f.target),
    store = new WorkStore(h.f.target);
  assert.equal(coverage.main.head, h.f.head);
  for (const [table, rows] of Object.entries(h.capsule.tables))
    assert.deepEqual(
      [...hostedRecoveryRows(source, store.load().hostedRecovery, table)],
      rows.map(JSON.parse),
    );
  assert.equal(source.object(h.f.blob).toString(), 'accepted only on hosted\n');
  const raw = decodeLandingCapsule(
    h.encoded.body,
    h.encoded.pointer,
    h.capsule.projectId,
    h.capsule.submissionId,
  );
  assert.deepEqual(
    raw,
    h.capsule,
    'privileged raw recovery preserves every original canonical byte and digest',
  );
  assert.equal(h.f.counters().reconnects, 0);
});

test('S1 recovery excludes published copies before removal and fences a publication during an export', async t => {
  const h = await fixture(t);
  const old = (await h.f.transport.prepare()).selection;
  h.publish();
  await assert.rejects(
    h.f.transport.hostedPage(old, 'projectHostedAcceptancePlans', null),
    error => (error.code ?? error.data?.code) === 'WORK_STALE',
  );
  const { selection } = await h.f.transport.prepare();
  const table = 'projectHostedAcceptancePlans';
  const live = await h.f.transport.hostedPage(selection, table, null);
  assert.deepEqual(live.rows, []);
  const archived = await h.f.transport.hostedPage(selection, table, live.cursor);
  assert.deepEqual(archived.rows, h.capsule.tables[table]);
  const args = {
    projectId: h.capsule.projectId,
    selection: canonicalPayload(selection),
    table,
    cursor: live.cursor,
    capsuleProtocol: 1,
  };
  await assert.rejects(
    h.action(args, 'uninvited'),
    error => (error.code ?? error.data?.code) === 'PROJECT_UNAVAILABLE',
  );
  await assert.rejects(
    h.s.call('legacyCapsuleRecovery', recovery.prepare, {
      projectId: h.capsule.projectId,
      operationId: h.f.request.operationId,
    }),
    error => (error.code ?? error.data?.code) === 'CLI_UPGRADE_REQUIRED',
  );
});

test('S1 recovery returns the same current-handle redaction before and after relocation, never raw capsule identity or URL', async t => {
  const h = await fixture(t, { privateActor: true });
  const old = (await h.f.transport.prepare()).selection;
  const table = 'projectHostedAcceptancePlans';
  const before = await h.f.transport.hostedPage(old, table, null);
  assert(before.rows[0].includes('current-author'));
  h.publish();
  const selection = (await h.f.transport.prepare()).selection;
  h.s.tables[table].clear();
  const live = await h.f.transport.hostedPage(selection, table, null);
  const after = await h.f.transport.hostedPage(selection, table, live.cursor);
  assert.deepEqual(after.rows, before.rows);
  assert(!JSON.stringify(after).includes('user_syntheticArchiveAuthorAAAA'));
  assert(!JSON.stringify(after).includes('https://'));
  assert(h.capsule.tables[table][0].includes('user_syntheticArchiveAuthorAAAA'));
});

test('S1 recovery excludes staged pages of an unaccepted earlier attempt throughout partial physical removal', async t => {
  const h = await fixture(t);
  const receiptId = randomUUID();
  const originalPlan = [...h.s.tables.projectHostedAcceptancePlans.values()][0];
  const originalPage = [...h.s.tables.projectHostedAcceptancePages.values()][0];
  const plan = { ...originalPlan, _id: 'projectHostedAcceptancePlans-syntheticOlder', receiptId };
  const page = { ...originalPage, _id: 'projectHostedAcceptancePages-syntheticOlder', receiptId };
  h.s.tables.projectHostedAcceptancePlans.set(plan._id, plan);
  h.s.tables.projectHostedAcceptancePages.set(page._id, page);
  h.publish();
  const { selection } = await h.f.transport.prepare();
  const live = await h.f.transport.hostedPage(selection, 'projectHostedAcceptancePages', null);
  assert.deepEqual(live.rows, [], 'published capsule owns pages before their compact ledger is installed');
  const ledger = await import(moduleUrl('../convex/projectLandingCapsuleLedger.ts'));
  h.s.insert('projectFinishReadRows', {
    kind: ledger.capsulePageKind,
    projectId: h.capsule.projectId,
    submissionId: h.capsule.submissionId,
    sourceId: ledger.capsulePageKey(h.capsule.projectId, receiptId, page.kind, page.index),
    value: ledger.compactCapsulePage(page),
  });
  h.s.tables.projectHostedAcceptancePlans.delete(plan._id);
  const resumed = await h.f.transport.hostedPage(selection, 'projectHostedAcceptancePages', null);
  assert.deepEqual(resumed.rows, [], 'compact ledger keeps ownership once the old plan copy is removed');
});
