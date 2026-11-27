// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { workEventRows } from './work-event-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { seedAuthorityMain } from './source-authority-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const authority = await import(moduleUrl('../convex/projectSourceAuthority.ts'));
const work = await import(moduleUrl('../convex/projectWork.ts'));
const actions = await import(moduleUrl('../convex/projectWorkActions.ts'));
const channels = await import(moduleUrl('../convex/projectHostedChannels.ts'));
const native = { mode: 'native-owner', epoch: 0 };
const server = { mode: 'server', epoch: 1 };
const code = value => error => (error.data?.code ?? error.code) === value;
const stale = current => error => {
  assert.equal(error.data?.code ?? error.code, 'SOURCE_AUTHORITY_STALE');
  assert.deepEqual(error.data?.authority ?? error.authority, current);
  return true;
};
function setup({ seeded = true } = {}) {
  const s = lanesFixture();
  const projectId = s.insert('hostedProjects', {
    owner: 'owner',
    name: 'Synthetic authority',
    key: randomUUID(),
    currentBackup: null,
    revision: 0,
  });
  if (seeded) seedAuthorityMain(s, projectId, 'c'.repeat(64), native);
  const transition = (expected = native, mode = 'server', operationId = randomUUID(), actor) =>
    s.call(
      'transition',
      authority.transition,
      {
        projectId,
        expected,
        mode,
        operationId,
        ...(s.tables.hostedProjects.get(projectId).currentBackup
          ? { ownerDrain: { revision: 0, fingerprint: 'synthetic-drained' } }
          : {}),
      },
      actor,
    );
  return { ...s, projectId, transition };
}

test('legacy authority transition leaves hosted main readable at its original source and new epoch (0667c0d8)', async () => {
  const s = setup(),
    operationId = randomUUID();
  const [row] = s.tables.projectHostedChannels.values();
  const original = JSON.parse(row.selection);
  await s.transition(native, 'server', operationId);
  const read = async () => JSON.parse(await s.call('current', channels.current, { projectId: s.projectId }));
  assert.deepEqual(await read(), { ...original, authority: server });
  const advanced = { mode: 'server', epoch: 2 };
  assert.deepEqual(await s.transition(server), advanced);
  assert.deepEqual(await s.transition(native, 'server', operationId), server);
  assert.deepEqual(await read(), { ...original, authority: advanced });
});

test('an existing epoch mismatch is repaired by a new transition at the current epoch', async () => {
  const s = setup();
  const [row] = s.tables.projectHostedChannels.values();
  const original = JSON.parse(row.selection);
  s.patch('hostedProjects', s.projectId, { sourceAuthority: server });
  const read = () => s.call('current', channels.current, { projectId: s.projectId });
  await assert.rejects(read(), code('SOURCE_AUTHORITY_CHANGED'));
  const authority = await s.transition(server, 'server');
  assert.deepEqual(authority, { mode: 'server', epoch: 2 });
  assert.deepEqual(JSON.parse(await read()), { ...original, authority });
});

test('transition CAS is idempotent across later transitions; rollback advances the epoch', async () => {
  const s = setup(),
    operationId = randomUUID();
  assert.deepEqual(await s.transition(native, 'server', operationId), server);
  assert.deepEqual(await s.transition(native, 'server', operationId), server);
  const rolledBack = { mode: 'native-owner', epoch: 2 };
  assert.deepEqual(await s.transition(server, 'native-owner'), rolledBack);
  assert.deepEqual(await s.transition(native, 'server', operationId), server);
  assert.deepEqual(s.tables.hostedProjects.get(s.projectId).sourceAuthority, rolledBack);
  assert.equal(s.tables.projectSourceAuthorityTransitions.size, 2);
  await assert.rejects(s.transition(native), stale(rolledBack));
  await assert.rejects(s.transition(native, 'server-shadow', operationId), code('WORK_OPERATION_CHANGED'));
  await assert.rejects(
    s.transition(rolledBack, 'server', randomUUID(), 'stranger'),
    code('PROJECT_UNAVAILABLE'),
  );
  await assert.rejects(s.transition(rolledBack, 'server', randomUUID(), null), code('PROJECT_UNAVAILABLE'));
  const before = structuredClone(s.tables);
  s.decorateContext(ctx => {
    ctx.db.insert = async () => {
      throw Error('synthetic receipt failure');
    };
  });
  await assert.rejects(s.transition(rolledBack), code('HOSTED_REQUEST_FAILED'));
  assert.deepEqual(s.tables, before, 'project CAS and receipt are atomic');
});

for (const sameOperation of [false, true])
  test(`concurrent transitions ${sameOperation ? 'replay one operation' : 'have exactly one CAS winner'} with OCC`, async () => {
    const s = setup(),
      id = randomUUID();
    const outcomes = await Promise.allSettled([
      s.transition(native, 'server', id),
      s.transition(native, 'server', sameOperation ? id : randomUUID()),
    ]);
    assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, sameOperation ? 2 : 1);
    if (!sameOperation) assert.ok(stale(server)(outcomes.find(x => x.status === 'rejected').reason));
    assert.equal(s.tables.projectSourceAuthorityTransitions.size, 1);
    assert.deepEqual(s.tables.hostedProjects.get(s.projectId).sourceAuthority, server);
  });

test('legacy final append transaction fences an authority switch', async () => {
  const s = setup();
  await s.transition();
  const input = { projectId: s.projectId, operationId: randomUUID(), revision: 0, command: '{}' };

  const command = JSON.stringify({
    action: 'accept-hosted-channel',
    channel: 'main',
    viewId: randomUUID(),
    head: 'a'.repeat(64),
    archiveSha256: 'b'.repeat(64),
    previousId: null,
  });
  await assert.rejects(
    s.call('stale-final-append', work.append, {
      projectId: s.projectId,
      owner: 'owner',
      operationId: input.operationId,
      previousRevision: 0,
      command,
      request: 'original',
    }),
    stale(server),
  );
  assert.equal(workEventRows(s.tables).length, 0);
});

test('existing seed rejects a stale epoch using its authorized project row', async () => {
  // The seed is under test: authority is given directly, since a switch needs a seeded main.
  const s = setup({ seeded: false });
  s.patch('hostedProjects', s.projectId, { sourceAuthority: server });
  const selection = {
    schema: 2,
    projectId: s.projectId,
    snapshotId: randomUUID(),
    sourceRevision: 0,
    channel: 'main',
    head: 'a'.repeat(64),
    authority: server,
    receipt: { id: 'main-0', kind: 'server', previousHead: null, previousReceiptId: null },
  };
  const input = {
    projectId: s.projectId,
    actor: 'owner',
    operationId: randomUUID(),
    selection: JSON.stringify(selection),
  };
  await s.call('seed-current', channels.seed, input);
  await s.transition(server, 'server');
  await assert.rejects(
    s.call('seed-stale', channels.seed, { ...input, operationId: randomUUID() }),
    stale({ mode: 'server', epoch: 2 }),
  );
  assert.equal(s.tables.projectHostedChannels.size, 1);
  await s.call('seed-replay', channels.seed, input); // completed receipt cannot write or rewind main
});

test('transition reports indexed nonterminal owner entries and batches without reading terminal history', async () => {
  const s = setup();
  const { HOSTED_WORK_INDEX_FORMAT } = await import('../dist/work-hosted-summary.js');
  const generationId = s.insert('projectWorkGenerations', {
    projectId: s.projectId,
    backupId: 'backup',
    format: HOSTED_WORK_INDEX_FORMAT,
    status: 'ready',
    revision: 0,
    initialRevision: 0,
    nextBatch: 0,
    metadata: '{}',
  });
  s.patch('hostedProjects', s.projectId, {
    work: { generationId, backupId: 'backup', operationId: 'seed', initialRevision: 0, revision: 0 },
  });
  const entry = s.insert('projectWorkRecords', {
    projectId: s.projectId,
    generationId,
    collection: 'landingEntries',
    key: 'waiting-entry',
    status: 'awaiting-review',
    parent: '',
    position: 0,
    value: '{}',
  });
  const batch = s.insert('projectWorkRecords', {
    projectId: s.projectId,
    generationId,
    collection: 'landingBatches',
    key: 'checking-batch',
    status: 'checking',
    parent: '',
    position: 0,
    value: '{}',
  });
  for (let i = 0; i < 200; i++)
    s.insert('projectWorkRecords', {
      projectId: s.projectId,
      generationId,
      collection: 'landingEntries',
      key: `done-${i}`,
      status: 'accepted',
      parent: '',
      position: i + 1,
      value: '{}',
    });
  await assert.rejects(s.transition(), e => {
    assert.equal(e.data.code, 'SOURCE_AUTHORITY_DRAIN_REQUIRED');
    assert.match(e.data.message, /waiting-entry/);
    assert.match(e.data.message, /checking-batch/);
    return true;
  });
  assert(s.counts.at(-1).documents < 20, 'terminal history is not hydrated');
  assert.equal(s.tables.hostedProjects.get(s.projectId).sourceAuthority, undefined);
  s.patch('projectWorkRecords', entry, { status: 'failed' });
  s.patch('projectWorkRecords', batch, { status: 'completed' });
  assert.deepEqual(await s.transition(), server);
});

test('a bootstrap seed refuses a retained working physical root without selecting main', async t => {
  const s = setup({ seeded: false });
  s.patch('hostedProjects', s.projectId, { sourceAuthority: server });
  const head = 'a'.repeat(64);
  const id = s.insert('projectObjects', {
    projectId: s.projectId,
    digest: head,
    size: 1,
    nonce: randomUUID(),
    removed: false,
    location: 'r2',
    r2Committed: true,
    r2Key: `v1/p/${s.projectId}/o/${head}`,
    statePhysical: { sha256: 'b'.repeat(64), size: 1 },
  });
  const selection = {
    schema: 2,
    projectId: s.projectId,
    snapshotId: randomUUID(),
    sourceRevision: 0,
    channel: 'main',
    head,
    authority: server,
    receipt: { id: 'main-0', kind: 'server', previousHead: null, previousReceiptId: null },
  };
  const input = {
    projectId: s.projectId,
    actor: 'owner',
    operationId: randomUUID(),
    selection: JSON.stringify(selection),
  };
  await assert.rejects(s.call('seed-working-root', channels.seed, input), code('SOURCE_HASH_MISMATCH'));
  assert.equal(s.tables.projectHostedChannels.size, 0);
  s.patch('projectObjects', id, { statePhysical: undefined });
  await s.call('seed-rootless', channels.seed, input);
  const count = s.counts.findLast(item => item.name === 'seed-rootless');
  t.diagnostic(
    JSON.stringify({
      seed: 'rootless',
      calls: 1,
      documents: count.documents,
      readBytes: count.readBytes,
      writes: count.writes,
      writeBytes: count.writeBytes,
    }),
  );
  assert.equal(s.tables.projectHostedChannels.size, 1);
});

test('a switch to server authority is refused until hosted main is seeded, and changes nothing (2abda01f)', async () => {
  const s = setup({ seeded: false });
  await assert.rejects(s.transition(), error => {
    assert.equal(error.data?.code ?? error.code, 'SOURCE_UNAVAILABLE');
    assert.match(error.data?.message ?? error.message, /not been seeded/);
    return true;
  });
  assert.equal(s.tables.hostedProjects.get(s.projectId).sourceAuthority, undefined);
  assert.equal(s.tables.projectSourceAuthorityTransitions.size, 0);
  seedAuthorityMain(s, s.projectId, 'c'.repeat(64), native);
  assert.deepEqual(await s.transition(), server);
});
