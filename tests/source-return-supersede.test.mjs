// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFunctionReference } from 'convex/server';
import { randomUUID } from 'node:crypto';
import { fixture, modules } from './project-exchange-fixture.mjs';
const code = expected => error => error.data?.code === expected || error.code === expected;
function setup() {
  const s = fixture(),
    input = {
      projectId: 'project',
      operationId: randomUUID(),
      pushOperationId: randomUUID(),
      expectedBackupId: 'prior',
      revision: 17,
      replacementId: randomUUID(),
    };
  s.tables.hostedProjects.get('project').work = { backupId: 'prior', revision: 17 };
  return { s, input, supersede: () => modules.projectReturnSupersede.supersede._handler(s.ctx, input) };
}
test('supersede records exact original pins, preserves data and replays after hosted moves', async () => {
  const { s, input, supersede } = setup();
  const before = s.tables.projectBackups.size;
  await supersede();
  assert.equal(s.tables.projectReturnSupersessions.size, 1);
  s.tables.hostedProjects.get('project').work.revision++;
  await supersede();
  assert.equal(s.tables.projectReturnSupersessions.size, 1);
  assert.equal(s.tables.projectBackups.size, before);
  await assert.rejects(
    s.ctx.runQuery(makeFunctionReference('projectReturnIndexStage:resume'), {
      projectId: 'project',
      owner: 'owner',
      backupId: 'candidate',
      revision: 19,
      operationId: input.operationId,
    }),
    code('SOURCE_RETURN_SUPERSEDED'),
  );
  await assert.rejects(
    modules.projectWork.returnSource._handler(s.ctx, {
      projectId: 'project',
      owner: 'owner',
      operationId: input.operationId,
      request: 'request',
      command: '{}',
      backupId: 'candidate',
      expectedBackupId: 'prior',
      expectedRevision: 17,
      localRevision: 18,
    }),
    code('SOURCE_RETURN_SUPERSEDED'),
  );
  await assert.rejects(
    modules.projectReturnSupersede.supersede._handler(s.ctx, { ...input, replacementId: randomUUID() }),
    code('WORK_OPERATION_CHANGED'),
  );
});
test('supersede refuses an already committed return before changing state', async () => {
  const { s, input, supersede } = setup();
  s.tables.projectWorkEvents.set('receipt', { projectId: 'project', operationId: input.operationId });
  await assert.rejects(supersede(), code('SOURCE_RETURN_COMMITTED'));
  assert.equal(s.tables.projectReturnSupersessions.size, 0);
});
for (const moved of ['revision', 'backup'])
  test(`supersede refuses moved hosted ${moved}`, async () => {
    const { s, supersede } = setup();
    if (moved === 'revision')
      s.tables.projectWorkHeads.set('head', { projectId: 'project', backupId: 'prior', revision: 18 });
    else s.tables.hostedProjects.get('project').work.backupId = 'different';
    await assert.rejects(supersede(), code('WORK_STALE'));
    assert.equal(s.tables.projectReturnSupersessions.size, 0);
  });
test('supersede requires current ownership on first use and replay', async () => {
  const { s, supersede } = setup();
  await supersede();
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'someone-else' });
  await assert.rejects(supersede(), code('PROJECT_UNAVAILABLE'));
  s.ctx.auth.getUserIdentity = async () => null;
  await assert.rejects(supersede(), code('AUTH_REQUIRED'));
});

for (const crash of ['before server', 'lost server reply', 'before local commit'])
  test(`supersede recovers ${crash} with the reserved replacement identity`, async t => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { ConvexHttpClient } = await import('convex/browser');
    const { ConvexError } = await import('convex/values');
    const { initNative } = await import('../dist/native-work.js');
    const { WorkStore } = await import('../dist/work-store.js');
    const { updateHostState, readHostState } = await import('../dist/host-binding.js');
    const { supersedeRetainedPush } = await import('../dist/bound-exchange-supersede.js');
    const previousToken = process.env.FORGE_AUTH_TOKEN;
    process.env.FORGE_AUTH_TOKEN = 'synthetic-token';
    t.after(() => {
      if (previousToken === undefined) delete process.env.FORGE_AUTH_TOKEN;
      else process.env.FORGE_AUTH_TOKEN = previousToken;
    });
    const root = mkdtempSync(join(tmpdir(), 'forge-supersede-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;');
    initNative(root);
    const store = new WorkStore(root),
      { s, input } = setup();
    updateHostState(store, state => {
      state.binding = {
        projectId: 'project',
        deployment: 'https://fixture.convex.cloud',
        projectUrl: 'https://fixture.invalid',
        operationId: randomUUID(),
        name: 'Synthetic',
        visibility: 'private',
        backupId: 'prior',
      };
      state.push = {
        projectId: 'project',
        deployment: state.binding.deployment,
        operationId: input.pushOperationId,
        previous: 'prior',
        revision: store.revision(),
        returnSource: { expectedBackupId: 'prior', revision: 17, operationId: input.operationId },
      };
    });
    let stopped = crash === 'before server',
      lost = crash === 'lost server reply',
      failLocal = crash === 'before local commit';
    const requests = [];
    t.mock.method(ConvexHttpClient.prototype, 'mutation', async (_ref, args) => {
      const pending = readHostState(store).supersede;
      assert.equal(pending.replacementId, args.replacementId, 'identity persisted before network access');
      requests.push(args);
      if (stopped) throw new Error('synthetic network stop');
      await modules.projectReturnSupersede.supersede._handler(s.ctx, args);
      if (lost) {
        lost = false;
        throw new ConvexError({ code: 'HOSTED_ACTION_FAILED', message: 'lost supersede reply' });
      }
      return null;
    });
    const locked = store.locked.bind(store);
    t.mock.method(store, 'locked', (...args) => {
      if (failLocal && s.tables.projectReturnSupersessions.size) {
        failLocal = false;
        throw new Error('synthetic local stop');
      }
      return locked(...args);
    });
    if (crash !== 'lost server reply') {
      await assert.rejects(supersedeRetainedPush(store, true, () => {}));
      assert(readHostState(store).supersede);
      assert.equal(readHostState(store).push.operationId, input.pushOperationId);
      stopped = false;
      await supersedeRetainedPush(store, false, () => {});
    } else await supersedeRetainedPush(store, true, () => {});
    const state = readHostState(store);
    assert.equal(state.supersede, undefined);
    assert.equal(state.supersededPushes.length, 1);
    assert.equal(state.push.operationId, requests[0].replacementId);
    assert.equal(state.push.needsBaseline, true);
    assert.equal(s.tables.projectReturnSupersessions.size, 1);
    for (const request of requests) assert.deepEqual(request, requests[0]);
    await supersedeRetainedPush(store, true, () => {});
    assert.equal(state.push.operationId, readHostState(store).push.operationId);
  });
