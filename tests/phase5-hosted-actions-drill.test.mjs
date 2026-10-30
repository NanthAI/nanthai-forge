// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { virtualClientInterruption } from '../scripts/phase5-hosted-actions-context.mjs';
import { runPins } from '../scripts/phase5-hosted-actions-drill.mjs';

for (const offlineMs of [0, 600_000, 1_800_000]) {
  test(`Q4 client-only virtual interruption ${offlineMs} makes no live calls`, async () => {
    let liveCalls = 0;
    const result = await virtualClientInterruption(
      offlineMs,
      () => liveCalls,
      offline => offline(),
    );
    assert.equal(result.offlineMs, offlineMs);
    assert.equal(result.physicalOutage, false);
    assert.equal(result.liveCallsWhileOffline, 0);
    assert.equal(liveCalls, 0);
  });
}
test('Q4 interruption rejects a client that leaks a live call while disconnected', async () => {
  let liveCalls = 0;
  await assert.rejects(
    virtualClientInterruption(
      600_000,
      () => liveCalls,
      async offline => {
        liveCalls++;
        await offline();
      },
    ),
    /offline client must make zero live calls/,
  );
});
test('Q4 passed-check replay pins catch changed provider execution or terminal evidence', () => {
  const original = {
    id: 'run',
    executionId: 'provider-run',
    request: { candidateId: 'candidate' },
    planDigest: 'plan',
    terminalDigest: 'terminal',
    status: 'passed',
    endedAt: 'time',
    counts: { completed: 1, passed: 1, failed: 0 },
  };
  for (const field of ['id', 'executionId', 'planDigest', 'terminalDigest', 'endedAt']) {
    assert.notDeepEqual(runPins(original), runPins({ ...original, [field]: 'replacement' }));
  }
  assert.deepEqual(runPins(original), runPins({ ...original, cost: { status: 'observed' } }));
});

test('Q4 save completion replays exactly the original operation to acknowledge the editing root', async () => {
  const { saveActionsDrillLane } = await import('../scripts/phase5-hosted-actions-drill.mjs');
  const request = { operationId: 'original-operation', laneId: 'lane', message: 'save' };
  const calls = [];
  const context = {
    agent: root => ({
      dispatch: async (action, input) => {
        calls.push({ root, action, input });
        return { operationId: input.operationId };
      },
    }),
    waitSelected: async (_name, args) => {
      calls.push({ wait: args });
      return { terminal: { outcome: { status: 'completed' } } };
    },
  };
  await saveActionsDrillLane(context, 'root', request);
  assert.deepEqual(calls, [
    { root: 'root', action: 'save', input: request },
    { wait: { operationId: request.operationId } },
    { root: 'root', action: 'save', input: request },
  ]);
});
test('Q4 Actions fixture has an offline-installable dependency-free npm lockfile', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { prepareActionsDrillFiles } = await import('../scripts/phase5-hosted-actions-fixture.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'forge-q4-actions-fixture-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  prepareActionsDrillFiles(directory);
  const result = spawnSync('npm', ['ci', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('Q4 configure makes no policy or runner write without the owner-proven repository binding', async () => {
  const { configureActionsDrill } = await import('../scripts/phase5-hosted-actions-drill.mjs');
  await assert.rejects(
    configureActionsDrill({
      report: {},
      directory: 'synthetic-root',
      query: async name => {
        assert.equal(name, 'githubBindingStore:list');
        return { page: [] };
      },
      mutation: () => assert.fail('no policy or runner mutation before repository proof'),
      agent: () => assert.fail('no check or runner configuration before repository proof'),
    }),
    /owner must finish/,
  );
});

test('Q4 cancellation waits for canonical publication and follows a queued member exact check', async () => {
  const { waitForCancellationCheck } = await import('../scripts/phase5-hosted-actions-recovery.mjs');
  let canonical = false;
  const selected = { request: { phase: 'queued' }, attempt: { check: { runId: 'exact-run' } } };
  const context = {
    waitSelected: async (name, args, done) => {
      if (name === 'projectHostedFinishObserve:page') {
        assert.equal(args.operationId, 'finish');
        assert.equal(done({ submission: { preparing: true } }), false);
        assert.equal(done({ submission: { preparing: false } }), true);
        canonical = true;
        return {};
      }
      assert(canonical, 'status must not be queried for an unpublished desired goal');
      assert.equal(name, 'projectHostedLanding:status');
      assert.equal(args.submissionId, 'submission');
      assert.equal(done(selected), true, 'queued batch members can own the executing check');
      return selected;
    },
  };
  assert.equal(
    (await waitForCancellationCheck(context, 'finish', 'submission')).attempt.check.runId,
    'exact-run',
  );
});
