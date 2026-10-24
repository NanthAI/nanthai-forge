// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { state } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { HOSTED_WORK_INDEX_FORMAT } from '../dist/work-hosted-summary.js';
const checks = await import(moduleUrl('../convex/projectCheckRequests.ts'));
const acceptance = await import(moduleUrl('../convex/ownerAcceptance.ts'));
const code = expected => error => error.data?.code === expected;

async function fixture() {
  const s = state([]),
    projectId = 'project',
    runnerId = 'runner';
  s.tables.hostedProjects.set(projectId, {
    _id: projectId,
    owner: 'owner',
    key: 'owner-key',
    hostingRequest: 'hosted',
    currentBackup: 'backup',
    work: { generationId: 'generation', backupId: 'backup' },
  });
  s.tables.projectBackups.set('backup', { _id: 'backup', projectId, preview: { format: 'native' } });
  s.tables.projectWorkGenerations.set('generation', {
    _id: 'generation',
    projectId,
    backupId: 'backup',
    status: 'ready',
    format: HOSTED_WORK_INDEX_FORMAT,
  });
  const viewId = randomUUID(),
    checkId = randomUUID(),
    head = 'a'.repeat(64),
    definition = 'b'.repeat(64);
  for (const [collection, key, value] of [
    ['views', viewId, { id: viewId, intentId: randomUUID(), status: 'clean', head }],
    ['checks', checkId, { id: checkId, name: 'Synthetic check', definition }],
  ])
    s.tables.projectWorkRecords.set(key, {
      _id: key,
      generationId: 'generation',
      collection,
      key,
      value: JSON.stringify(value),
    });
  for (const contributor of ['requester', 'runner-owner', 'unrelated', 'revoked'])
    s.tables.projectContributors.set(contributor, { _id: contributor, projectId, contributor });
  s.tables.projectReaders.set('reader', { _id: 'reader', projectId, reader: 'reader' });
  s.caller('runner-owner');
  const scope = { projectId, runnerId };
  await checks.connect._handler(s.ctx, { ...scope, name: 'Synthetic runner', listening: true });
  const input = { ...scope, operationId: randomUUID(), viewId, head, checkId, definition };
  const item = await checks.request._handler(s.ctx, input);
  const selection = { ...scope, operationId: item.operationId };
  const report = {
    status: 'passed',
    runId: item.operationId,
    environmentFingerprint: null,
    startedAt: null,
    endedAt: '2026-10-17T00:00:00.000Z',
    exitCode: 0,
    message: 'Synthetic report',
  };
  return { ...s, scope, input, item, selection, report };
}

test('queueing requires the target runner owner, even for project owners and retries', async () => {
  const s = await fixture();
  assert.deepEqual(await checks.request._handler(s.ctx, s.input), s.item);
  for (const caller of ['requester', 'unrelated', 'owner', 'reader', 'outsider', null]) {
    s.caller(caller);
    await assert.rejects(
      checks.request._handler(s.ctx, { ...s.input, operationId: randomUUID() }),
      code('PROJECT_UNAVAILABLE'),
    );
  }
  s.caller('owner');
  await checks.connect._handler(s.ctx, {
    projectId: s.scope.projectId,
    runnerId: 'owner-runner',
    name: 'Owner computer',
    listening: true,
  });
  const own = await checks.request._handler(s.ctx, {
    ...s.input,
    operationId: randomUUID(),
    runnerId: 'owner-runner',
  });
  assert.equal(own.actor, 'owner');
  s.caller('runner-owner');
  await assert.rejects(
    checks.request._handler(s.ctx, { ...s.input, operationId: randomUUID(), runnerId: 'owner-runner' }),
    code('PROJECT_UNAVAILABLE'),
  );
  s.tables.projectCheckRequests.get(s.item._id).actor = 'requester';
  s.caller('requester');
  await assert.rejects(checks.request._handler(s.ctx, s.input), code('PROJECT_UNAVAILABLE'));
  assert.equal(s.tables.projectCheckRequests.size, 2);
});

const callers = ['requester', 'runner-owner', 'owner', 'unrelated', 'reader', 'outsider', 'revoked', null];
for (const requestState of ['queued', 'claimed', 'finished']) {
  for (const caller of callers) {
    test(`cancel ${requestState}: ${caller ?? 'signed out'}`, async () => {
      const s = await fixture(),
        row = s.tables.projectCheckRequests.get(s.item._id);
      Object.assign(row, {
        actor: 'requester',
        state: requestState,
        report: requestState === 'finished' ? s.report : null,
      });
      s.tables.projectContributors.delete('revoked');
      s.caller(caller);
      const before = structuredClone(row);
      if (['requester', 'runner-owner', 'owner'].includes(caller)) {
        const result = await checks.cancel._handler(s.ctx, s.selection);
        if (requestState === 'finished') assert.deepEqual(result, before);
        else {
          assert.equal(result.cancelRequested, true);
          assert.equal(result.state, requestState === 'queued' ? 'finished' : 'claimed');
        }
        assert.deepEqual(await checks.cancel._handler(s.ctx, s.selection), result);
      } else {
        await assert.rejects(checks.cancel._handler(s.ctx, s.selection), code('PROJECT_UNAVAILABLE'));
        assert.deepEqual(row, before);
      }
    });
  }
}
for (const caller of callers) {
  test(`update claimed request: ${caller ?? 'signed out'}`, async () => {
    const s = await fixture(),
      row = s.tables.projectCheckRequests.get(s.item._id);
    Object.assign(row, { actor: 'requester', state: 'claimed' });
    s.tables.projectContributors.delete('revoked');
    s.caller(caller);
    const before = structuredClone(row),
      input = { ...s.selection, report: s.report };
    if (['requester', 'runner-owner', 'owner'].includes(caller)) {
      await assert.rejects(
        checks.update._handler(s.ctx, { ...input, runnerId: 'other-runner' }),
        code('NOT_FOUND'),
      );
      await assert.rejects(
        checks.update._handler(s.ctx, { ...input, report: { ...s.report, runId: randomUUID() } }),
        code('EVIDENCE_CHANGED'),
      );
      const result = await checks.update._handler(s.ctx, input);
      assert.equal(result.state, 'finished');
      assert.deepEqual(await checks.update._handler(s.ctx, input), result);
      await assert.rejects(
        checks.update._handler(s.ctx, { ...input, report: { ...s.report, status: 'failed' } }),
        code('WORK_OPERATION_CHANGED'),
      );
    } else {
      await assert.rejects(checks.update._handler(s.ctx, input), code('PROJECT_UNAVAILABLE'));
      assert.deepEqual(row, before);
    }
  });
}

test('revoked contributors cannot queue, replay, cancel, report, poll, claim or observe even on public projects', async () => {
  const s = await fixture();
  s.tables.hostedProjects.get(s.scope.projectId).visibility = 'public';
  s.tables.projectContributors.delete('runner-owner');
  for (const [name, input] of [
    ['request', { ...s.input, operationId: randomUUID() }],
    ['request', s.input],
    ['cancel', s.selection],
    ['update', { ...s.selection, report: s.report }],
    ['next', s.scope],
    ['claim', s.selection],
    ['observe', s.selection],
  ])
    await assert.rejects(checks[name]._handler(s.ctx, input), code('PROJECT_UNAVAILABLE'));
  assert.deepEqual(s.tables.projectCheckRequests.get(s.item._id), s.item);
});

test('retained foreign requests are skipped without blocking an owned request or rewriting rows', async () => {
  const s = await fixture();
  s.tables.projectCheckRequests.get(s.item._id).actor = 'requester';
  const foreign = structuredClone(s.tables.projectCheckRequests.get(s.item._id));
  assert.equal(await checks.next._handler(s.ctx, s.scope), null);
  await assert.rejects(checks.claim._handler(s.ctx, s.selection), code('PROJECT_UNAVAILABLE'));
  const own = await checks.request._handler(s.ctx, { ...s.input, operationId: randomUUID() });
  assert.equal((await checks.next._handler(s.ctx, s.scope)).operationId, own.operationId);
  await checks.claim._handler(s.ctx, { ...s.selection, operationId: own.operationId });
  assert.equal((await checks.next._handler(s.ctx, s.scope)).operationId, own.operationId);
  assert.deepEqual(s.tables.projectCheckRequests.get(s.item._id), foreign);
  s.caller('unrelated');
  await assert.rejects(
    checks.claim._handler(s.ctx, { ...s.selection, operationId: own.operationId }),
    code('PROJECT_UNAVAILABLE'),
  );
});

test('canonical owner recheck requests remain project-owner-only', async () => {
  const s = await fixture();
  s.tables.ownerAcceptanceRequests = new Map();
  const input = {
    projectId: s.scope.projectId,
    operationId: randomUUID(),
    recheck: true,
    viewId: s.input.viewId,
    head: s.input.head,
    expectedMain: null,
  };
  for (const caller of ['requester', 'runner-owner', 'unrelated', 'reader', 'outsider', null]) {
    s.caller(caller);
    await assert.rejects(acceptance.request._handler(s.ctx, input), code('PROJECT_UNAVAILABLE'));
  }
  s.caller('owner');
  const result = await acceptance.request._handler(s.ctx, input);
  assert.equal(result.requester, 'owner');
  assert.equal(result.recheck, true);
  assert.deepEqual(await acceptance.request._handler(s.ctx, input), result);
});
