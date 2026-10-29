// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const authority = await import(moduleUrl('../convex/projectSourceAuthority.ts'));
const owner = await import(moduleUrl('../convex/ownerAcceptance.ts'));
const exchange = await import(moduleUrl('../convex/projectExchange.ts'));
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
function setup() {
  const s = lanesFixture();
  const projectId = s.insert('hostedProjects', {
    owner: 'owner',
    name: 'Synthetic authority',
    key: randomUUID(),
    currentBackup: null,
    revision: 0,
  });
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

test('old owner completion is refused after switch and remains stale after rollback to owner mode', async () => {
  const s = setup();
  const input = {
    projectId: s.projectId,
    ownerId: s.tables.hostedProjects.get(s.projectId).key,
    operationId: randomUUID(),
    receipt: JSON.stringify({ status: 'rejected', reason: 'synthetic' }),
  };
  const request = {
    viewId: 'view',
    head: 'a'.repeat(64),
    expectedMain: null,
    actorKind: 'person',
    channel: 'main',
    requester: 'owner',
    createdAt: 1,
    receipt: null,
    state: 'requested',
  };
  const requestId = s.insert('ownerAcceptanceRequests', { ...input, ...request });
  const another = { ...input, operationId: randomUUID() };
  const completed = s.insert('ownerAcceptanceRequests', { ...another, ...request });
  await s.call('complete-before', owner.complete, another);
  assert.equal(s.tables.ownerAcceptanceRequests.get(completed).state, 'rejected');
  assert.equal(s.counts.at(-1).touched.filter(x => x === 'hostedProjects').length, 1);
  await assert.rejects(s.transition(), code('SOURCE_AUTHORITY_DRAIN_REQUIRED'));
  await s.call('complete-original-before-switch', owner.complete, input);
  await s.transition();
  await assert.rejects(s.call('stale-complete', owner.complete, input), stale(server));
  assert.equal(s.tables.ownerAcceptanceRequests.get(requestId).state, 'rejected');
  await s.transition(server, 'native-owner');
  await assert.rejects(
    s.call('rollback-stale-complete', owner.complete, input),
    stale({ mode: 'native-owner', epoch: 2 }),
  );
  s.patch('ownerAcceptanceRequests', requestId, { authorityEpoch: 2 });
  await s.call('rollback-complete', owner.complete, input);
  assert.equal(s.tables.ownerAcceptanceRequests.get(requestId).state, 'rejected');
});

test('stale upload/publication is fenced before receipt or object reads, including rollback ABA', async () => {
  const s = setup();
  const input = {
    projectId: s.projectId,
    owner: 'owner',
    operationId: randomUUID(),
    request: 'original',
    previous: null,
    digest: 'a'.repeat(64),
    size: 1,
    preview: {
      manifestDigest: 'a'.repeat(64),
      head: 'a'.repeat(64),
      format: 'native',
      revision: 0,
      intents: 0,
      lanes: 0,
      views: 0,
      runs: 0,
      files: 0,
      unavailable: 0,
      channels: [],
    },
  };
  s.insert('projectObjects', {
    projectId: s.projectId,
    digest: input.digest,
    size: 1,
    nonce: 'nonce',
    storageId: 'synthetic',
    removed: false,
  });
  const first = await s.call('publish-before', exchange.publish, input);
  assert.equal(s.counts.at(-1).touched.filter(x => x === 'hostedProjects').length, 1);
  await s.transition();
  for (const operationId of [input.operationId, randomUUID()]) {
    await assert.rejects(s.call('stale-publish', exchange.publish, { ...input, operationId }), stale(server));
    assert.deepEqual(s.counts.at(-1).touched, ['hostedProjects']);
  }
  assert.equal(s.tables.projectBackups.size, 1);
  await s.transition(server, 'native-owner');
  await assert.rejects(
    s.call('old-epoch', exchange.publish, { ...input, previous: first }),
    stale({ mode: 'native-owner', epoch: 2 }),
  );
  await s.call('publish-rollback', exchange.publish, {
    ...input,
    operationId: randomUUID(),
    previous: first,
    authorityEpoch: 2,
  });
  assert.equal(s.tables.projectBackups.size, 2);
});

test('legacy accept action and its final append transaction both fence a switch between them', async () => {
  const s = setup();
  await s.transition();
  const input = { projectId: s.projectId, operationId: randomUUID(), revision: 0, command: '{}' };
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: 'owner' }) },
    runQuery: async () => s.tables.hostedProjects.get(s.projectId),
  };
  await assert.rejects(actions.acceptChannel._handler(ctx, input), stale(server));
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
  assert.equal(s.tables.projectWorkEvents.size, 0);
});

test('existing seed rejects a stale epoch using its authorized project row', async () => {
  const s = setup();
  await s.transition();
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
