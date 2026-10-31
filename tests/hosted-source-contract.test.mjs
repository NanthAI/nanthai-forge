// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { emptyHostedProject } from '../dist/hosted-bootstrap.js';
import { hostedMainSchema } from '../dist/hosted-main.js';
import {
  sourceAuthority,
  nextSourceAuthority,
  requireSourceContract,
} from '../dist/hosted-source-authority.js';
import {
  canonicalPayload,
  hostedPayloadHash,
  hostedOperationSchema,
  hostedAttemptSchema,
  prepareHostedOperation,
  completeHostedOperation,
} from '../dist/hosted-source-operation.js';

const authority = await import(moduleUrl('../convex/projectSourceAuthority.ts'));
const main = await import(moduleUrl('../convex/projectMain.ts'));
const native = await import(moduleUrl('../convex/projectBackupObjects.ts'));
const bootstrap = await import(moduleUrl('../convex/projectBootstrapStore.ts'));
const github = await import(moduleUrl('../convex/projectGithubImportStore.ts'));
const creation = await import(moduleUrl('../convex/projectCreation.ts'));
const at = '2026-01-01T00:00:00.000Z';
const code = expected => error => (error.data?.code ?? error.code) === expected;
const defaultAuthority = { mode: 'native-owner', epoch: 0 };

test('native upload and an unpublished GitHub import keep native authority; a browser project is hosted from birth', async () => {
  const s = state([]);
  const nativeId = await native.open._handler(s.ctx, { key: randomUUID(), name: 'Native' });
  const input = { operationId: randomUUID(), name: 'Browser', at };
  const seed = emptyHostedProject(input.operationId, at);
  const objects = await Promise.all(
    seed.objects.map(async object => {
      const nonce = randomUUID();
      const storageId = await s.ctx.storage.store(
        new Blob([object.text], {
          type: `application/x-forge-object-${nonce}`,
        }),
      );
      return { storageId, nonce };
    }),
  );
  const { projectId: browserId } = await bootstrap.publish._handler(s.ctx, { ...input, objects });
  const cursor = await s.ctx.storage.store(new Blob(['synthetic']));
  const importId = await github.begin._handler(s.ctx, {
    actor: 'owner',
    operationId: randomUUID(),
    request: 'synthetic-import',
    name: 'Imported',
    repository: 'example/fixture',
    commit: 'a'.repeat(40),
    at,
    cursor,
    visibility: 'private',
  });
  const importedId = s.tables.projectGithubImports.get(importId).projectId;
  for (const projectId of [nativeId, importedId]) {
    const project = s.tables.hostedProjects.get(projectId);
    assert.deepEqual(project.sourceAuthority, defaultAuthority);
    assert.deepEqual(await authority.current._handler(s.ctx, { projectId }), defaultAuthority);
  }
  const born = { mode: 'server', epoch: 1 };
  assert.deepEqual(s.tables.hostedProjects.get(browserId).sourceAuthority, born);
  assert.deepEqual(await authority.current._handler(s.ctx, { projectId: browserId }), born);
  const main = [...s.tables.projectHostedChannels.values()].find(row => row.projectId === browserId);
  assert.equal(JSON.parse(main.selection).head, seed.head);
  assert.equal(s.tables.hostedProjects.get(nativeId).hostingRequest, undefined);
  assert.ok(s.tables.hostedProjects.get(browserId).hostingRequest);
  assert.ok(s.tables.hostedProjects.get(importedId).hostingRequest);
  assert.equal(
    await native.open._handler(s.ctx, {
      key: s.tables.hostedProjects.get(nativeId).key,
      name: 'Native',
    }),
    nativeId,
  );
});

test('legacy authority ignores hosting/presence and reads one project row without writes or scans', async () => {
  for (const hostingRequest of [undefined, 'browser-or-native-hosting', 'github-import']) {
    const project = { _id: 'project', owner: 'owner', hostingRequest, heartbeat: Date.now() };
    let reads = 0;
    const ctx = {
      auth: { getUserIdentity: async () => ({ subject: 'owner' }) },
      db: {
        get: async id => {
          assert.equal(id, 'project');
          reads++;
          return structuredClone(project);
        },
      },
    };
    assert.deepEqual(await authority.current._handler(ctx, { projectId: 'project' }), defaultAuthority);
    assert.equal(reads, 1);
    assert.equal(project.sourceAuthority, undefined);
  }
});

test('authority read enforces current access and returns explicit shadow/server modes', async () => {
  const s = state([]);
  s.tables.hostedProjects.set('project', { _id: 'project', owner: 'owner' });
  for (const mode of ['server-shadow', 'server']) {
    s.tables.hostedProjects.get('project').sourceAuthority = { mode, epoch: 7 };
    assert.deepEqual(await authority.current._handler(s.ctx, { projectId: 'project' }), { mode, epoch: 7 });
  }
  s.caller('reader');
  await assert.rejects(
    authority.current._handler(s.ctx, { projectId: 'project' }),
    code('PROJECT_UNAVAILABLE'),
  );
  s.tables.projectReaders.set('grant', { _id: 'grant', projectId: 'project', reader: 'reader' });
  await authority.current._handler(s.ctx, { projectId: 'project' });
  s.tables.projectReaders.clear();
  await assert.rejects(
    authority.current._handler(s.ctx, { projectId: 'project' }),
    code('PROJECT_UNAVAILABLE'),
  );
  s.caller(null);
  await assert.rejects(
    authority.current._handler(s.ctx, { projectId: 'project' }),
    code('PROJECT_UNAVAILABLE'),
  );
});

test('epoch increments on every prepared transition, including return to native, and stale CAS fails', async () => {
  let current = sourceAuthority({});
  const modes = ['server-shadow', 'server', 'native-owner', 'native-owner', 'server'];
  for (const [index, mode] of modes.entries()) {
    const before = structuredClone(current);
    current = nextSourceAuthority(current, current, mode);
    assert.deepEqual(current, { mode, epoch: index + 1 });
    assert.deepEqual(nextSourceAuthority(before, before, mode), current);
    assert.throws(
      () => nextSourceAuthority(current, before, 'native-owner'),
      code('SOURCE_AUTHORITY_CHANGED'),
    );
  }
  assert.throws(
    () => nextSourceAuthority(current, { ...current, mode: 'native-owner' }, 'server'),
    code('SOURCE_AUTHORITY_CHANGED'),
  );
  assert.throws(() =>
    nextSourceAuthority(
      { mode: 'server', epoch: Number.MAX_SAFE_INTEGER },
      { mode: 'server', epoch: Number.MAX_SAFE_INTEGER },
      'native-owner',
    ),
  );
  assert.throws(() => sourceAuthority({ sourceAuthority: { mode: 'server', epoch: -1 } }));
});

test('unsupported server-source client receives upgrade before reading any native generation', async () => {
  const s = state([]);
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    owner: 'owner',
    sourceAuthority: { mode: 'server', epoch: 2 },
  });
  s.ctx.db.query = () => {
    throw Error('Must not scan or consult a native/display fallback');
  };
  for (const maxSchema of [undefined, 1])
    await assert.rejects(
      main.current._handler(s.ctx, { projectId: 'project', maxSchema }),
      error => error.data?.code === 'CLI_UPGRADE_REQUIRED' && /Upgrade nforge/.test(error.data.message),
    );
  await assert.rejects(
    main.current._handler(s.ctx, { projectId: 'project', maxSchema: 2 }),
    code('SOURCE_UNAVAILABLE'),
  );
  s.caller('other');
  // Current authorization precedes capability disclosure.
  s.ctx.db.query = () => ({ withIndex: () => ({ unique: async () => null }) });
  await assert.rejects(main.current._handler(s.ctx, { projectId: 'project' }), code('PROJECT_UNAVAILABLE'));
  requireSourceContract(defaultAuthority);
  requireSourceContract({ mode: 'server-shadow', epoch: 1 });
  requireSourceContract({ mode: 'server', epoch: 2 }, 2);
});

test('source contract v2 carries snapshot, revision, State and receipt without historical backup membership', () => {
  const common = {
    projectId: 'project',
    channel: 'main',
    head: 'a'.repeat(64),
    receipt: { id: 'receipt', kind: 'native', previousHead: null, previousReceiptId: null },
  };
  const legacy = { ...common, schema: 1, generationId: 'old-generation', backupId: 'old-backup' };
  assert.deepEqual(hostedMainSchema.parse(legacy), legacy);
  const current = {
    ...common,
    schema: 2,
    snapshotId: 'snapshot',
    sourceRevision: 10,
    authority: { mode: 'server', epoch: 3 },
    receipt: {
      ...common.receipt,
      kind: 'server',
      previousHead: 'b'.repeat(64),
      previousReceiptId: 'previous',
    },
  };
  assert.deepEqual(hostedMainSchema.parse(current), current);
  assert.deepEqual(
    hostedMainSchema.parse({ ...current, seed: { backupId: 'old-backup', generationId: 'old-generation' } })
      .seed,
    { backupId: 'old-backup', generationId: 'old-generation' },
  );
  for (const invalid of [
    { ...current, sourceRevision: -1 },
    { ...current, snapshotId: '' },
    { ...current, head: 'not-a-state' },
    { ...current, authority: { mode: 'server', epoch: 1.5 } },
    { ...current, backupId: 'misleading-current-backup' },
  ])
    assert.equal(hostedMainSchema.safeParse(invalid).success, false);
});

function operationFixture() {
  const expected = {
    authorityEpoch: 4,
    resourceId: randomUUID(),
    resourceVersion: 1,
    head: 'a'.repeat(64),
    receiptId: 'main-receipt',
  };
  const payload = { action: 'save', files: [{ path: 'a.txt', blob: 'b'.repeat(64) }] };
  const request = {
    schema: 1,
    projectId: 'project',
    actor: 'owner',
    operationId: randomUUID(),
    expected,
    payloadHash: hostedPayloadHash(payload, expected),
  };
  const firstAttempt = {
    projectId: request.projectId,
    operationId: request.operationId,
    id: randomUUID(),
    parentAttemptId: null,
    at,
    expected,
    ids: { saveId: randomUUID(), jobId: randomUUID() },
  };
  return { request, payload, firstAttempt };
}

test('canonical payload hashes preserve array order and pins while ignoring object insertion order', () => {
  assert.equal(
    canonicalPayload({ b: [2, { z: 0, a: 1 }], a: 'x' }),
    canonicalPayload({ a: 'x', b: [2, { a: 1, z: 0 }] }),
  );
  const pins = { authorityEpoch: 0 };
  assert.notEqual(hostedPayloadHash([1, 2], pins), hostedPayloadHash([2, 1], pins));
  assert.notEqual(hostedPayloadHash({}, pins), hostedPayloadHash({}, { authorityEpoch: 1 }));
  for (const value of [undefined, { invalid: undefined }, NaN, new Date(at), 1n])
    assert.throws(() => canonicalPayload(value));
});

test('lost replies retain first attempt time/IDs; completed retries return original outcome', async () => {
  const { request, payload, firstAttempt } = operationFixture();
  let checks = 0;
  const authorize = async () => {
    checks++;
  };
  const initial = await prepareHostedOperation(request, payload, firstAttempt, undefined, authorize);
  assert.equal(initial.replayed, false);
  const resumed = await prepareHostedOperation(request, payload, null, initial.operation, authorize);
  assert.equal(resumed.replayed, true);
  assert.deepEqual(resumed.operation.firstAttempt, firstAttempt);
  const terminal = {
    at,
    attemptId: firstAttempt.id,
    outcome: { status: 'completed', result: { head: 'c'.repeat(64), receiptId: randomUUID() } },
  };
  const completed = completeHostedOperation(initial.operation, terminal);
  const replay = await prepareHostedOperation(request, payload, null, completed, authorize);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.operation.terminal, terminal);
  assert.deepEqual(
    completeHostedOperation(replay.operation, {
      ...terminal,
      outcome: { status: 'completed', result: 'newer outcome' },
    }),
    completed,
  );
  assert.equal(checks, 3);
  await assert.rejects(
    prepareHostedOperation(request, payload, null, completed, async () => {
      throw Error('access revoked');
    }),
    /access revoked/,
  );
});

test('changed payload, pins, actor, project or operation UUID cannot replay the retained receipt', async () => {
  const { request, payload, firstAttempt } = operationFixture();
  const { operation } = await prepareHostedOperation(
    request,
    payload,
    firstAttempt,
    undefined,
    async () => {},
  );
  for (const changed of [
    { ...request, actor: 'other' },
    { ...request, projectId: 'other' },
    { ...request, operationId: randomUUID() },
    { ...request, expected: { ...request.expected, authorityEpoch: 5 } },
    {
      ...request,
      expected: { ...request.expected, head: 'c'.repeat(64) },
      payloadHash: hostedPayloadHash(payload, { ...request.expected, head: 'c'.repeat(64) }),
    },
  ])
    await assert.rejects(
      prepareHostedOperation(changed, payload, null, operation, async () => {}),
      code('WORK_OPERATION_CHANGED'),
    );
  const changedPayload = { ...payload, action: 'abandon' };
  await assert.rejects(
    prepareHostedOperation(request, changedPayload, null, operation, async () => {}),
    code('WORK_OPERATION_CHANGED'),
  );
  await assert.rejects(
    prepareHostedOperation(
      { ...request, payloadHash: hostedPayloadHash(changedPayload, request.expected) },
      changedPayload,
      null,
      operation,
      async () => {},
    ),
    code('WORK_OPERATION_CHANGED'),
  );
});

test('first attempt pins cannot drift; named child attempts and failed terminal outcomes remain explicit', async () => {
  const { request, payload, firstAttempt } = operationFixture();
  assert.equal(
    hostedOperationSchema.safeParse({
      ...request,
      firstAttempt: { ...firstAttempt, expected: { ...request.expected, authorityEpoch: 5 } },
      terminal: null,
    }).success,
    false,
  );
  assert.equal(
    hostedOperationSchema.safeParse({
      ...request,
      firstAttempt: { ...firstAttempt, parentAttemptId: randomUUID() },
      terminal: null,
    }).success,
    false,
  );
  const child = hostedAttemptSchema.parse({
    ...firstAttempt,
    id: randomUUID(),
    parentAttemptId: firstAttempt.id,
    expected: { ...request.expected, head: 'd'.repeat(64) },
  });
  assert.equal(child.parentAttemptId, firstAttempt.id);
  const { operation } = await prepareHostedOperation(
    request,
    payload,
    firstAttempt,
    undefined,
    async () => {},
  );
  const failed = completeHostedOperation(operation, {
    at,
    attemptId: child.id,
    outcome: { status: 'failed', error: { code: 'CHANNEL_CHANGED', message: 'Main moved.' } },
  });
  const replay = await prepareHostedOperation(request, payload, null, failed, async () => {});
  assert.deepEqual(replay.operation.terminal, failed.terminal);
});

test('creation retry preserves explicit project authority rather than resetting its epoch', async () => {
  const s = state([]);
  const input = { owner: 'owner', key: randomUUID(), name: 'Existing' };
  const project = await creation.createProject(s.ctx, input);
  await s.ctx.db.patch(project._id, { sourceAuthority: { mode: 'server-shadow', epoch: 9 } });
  const retry = await creation.createProject(s.ctx, input);
  assert.deepEqual(retry.sourceAuthority, { mode: 'server-shadow', epoch: 9 });
});
