// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainPostAccept } from '../dist/post-accept-main.js';

for (const completed of [false, true])
  test(`an idle audit drain takes no Work writer lock (${completed ? 'already audited' : 'no requests'})`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'forge-idle-audit-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const data = {
      channelMoves: completed
        ? [
            {
              id: 'acceptance',
              channel: 'main',
              status: 'accepted',
              head: 'saved-main',
              postAccept: { checkId: 'verify' },
              postAcceptRunId: 'audit',
            },
          ]
        : [],
      runs: completed
        ? [
            {
              id: 'audit',
              head: 'saved-main',
              mainCheck: { channel: 'main' },
              status: 'passed',
              endedAt: '2026-01-01T00:00:00.000Z',
              check: { id: 'verify', definition: 'definition' },
            },
          ]
        : [],
      checks: [{ id: 'verify', definition: 'definition' }],
      intents: [],
      views: [],
    };
    // Model a detached wake arriving after another driver drained the audit.
    // A foreground checkpoint can have zero lock patience at this point.
    const before = structuredClone(data);
    await drainPostAccept({
      directory,
      native: false,
      load: () => structuredClone(data),
      locked: () => assert.fail('Completed audit must not contend with a foreground writer'),
    });
    assert.deepEqual(data, before);
  });

test('bounded audit observation expires without replacing an active audit', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-audit-timeout-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const data = {
    channelMoves: [],
    runs: [{ id: 'retained', status: 'running', mainCheck: { channel: 'main' } }],
    checks: [],
    intents: [],
    views: [],
  };
  await assert.rejects(
    drainPostAccept(
      {
        directory,
        native: false,
        load: () => structuredClone(data),
        locked: () => assert.fail('Expired observation must not modify Work'),
      },
      undefined,
      { timeoutMs: 0 },
    ),
    { code: 'GITHUB_SYNC_AUDIT_TIMEOUT' },
  );
  assert.equal(data.runs.length, 1);
  assert.equal(data.runs[0].id, 'retained');
});

for (const code of ['WORK_BUSY', 'WORK_STALE'])
  test(`main audit backs off ${code} and ends durably instead of spinning`, async t => {
    const { ForgeError } = await import('../dist/errors.js');
    const { readMainAuditState } = await import('../dist/post-accept-state.js');
    const root = mkdtempSync(join(tmpdir(), 'forge-stalled-audit-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const data = {
      revision: 1,
      channelMoves: [],
      runs: [{ id: 'retained', status: 'running', mainCheck: { channel: 'main' } }],
      checks: [],
      intents: [],
      views: [],
    };
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const waits = [];
    await assert.rejects(
      drainPostAccept(
        {
          directory: root,
          native: false,
          load: () => structuredClone(data),
          observing: task => task(),
          pointer: () => null,
          locked: () => {
            throw new ForgeError(code, 'Synthetic continuous contender');
          },
        },
        undefined,
        {
          stallMs: 3100,
          sleep: async ms => {
            waits.push(ms);
            t.mock.timers.tick(ms);
          },
        },
      ),
      { code: 'MAIN_AUDIT_STALLED' },
    );
    assert.deepEqual(waits, [1000, 2000, 4000]);
    const state = readMainAuditState({ directory: root });
    assert.equal(state.status, 'stalled');
    assert.equal(state.code, 'MAIN_AUDIT_STALLED');
    assert.deepEqual(state.runIds, ['retained']);
    assert.equal(data.runs[0].status, 'running');
    assert.equal(data.revision, 1);
  });

test('main audit progress uses provider evidence and ignores unrelated Work revisions', async t => {
  const { MainAuditWatchdog } = await import('../dist/post-accept-watchdog.js');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { readMainAuditState } = await import('../dist/post-accept-state.js');
  const root = mkdtempSync(join(tmpdir(), 'forge-audit-provider-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const store = { directory: root };
  const data = {
    revision: 1,
    channelMoves: [],
    runs: [{ id: 'audit', status: 'running', mainCheck: { channel: 'main' } }],
    intents: [],
  };
  const watchdog = new MainAuditWatchdog(store, 1000);
  watchdog.update(data);
  t.mock.timers.tick(900);
  mkdirSync(join(root, 'check-audit'));
  writeFileSync(join(root, 'check-audit/github-actions.json'), '{"states":{"job":"in_progress"}}');
  watchdog.updateRuns();
  t.mock.timers.tick(900);
  watchdog.update({ ...data, revision: 1000 });
  writeFileSync(
    join(root, 'check-audit/github-actions.json'),
    '{"states":{"job":"in_progress"},"apiFailures":[{"status":503}]}',
  );
  t.mock.timers.tick(101);
  assert.throws(() => watchdog.update({ ...data, revision: 2000 }), { code: 'MAIN_AUDIT_STALLED' });
  assert.deepEqual(readMainAuditState(store).runIds, ['audit']);
});

import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';

function interceptSpawn(t) {
  const calls = [];
  const original = cp.spawn;
  t.mock.method(cp, 'spawn', (...args) => {
    if (!args[1]?.[0]?.match(/\/(?:post-accept-main|check-controller-worker)\.js$/)) return original(...args);
    calls.push(args[1]);
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return calls;
}

test('regression: a wake during an outstanding snapshot is observed again', async t => {
  const { wakePostAccept } = await import('../dist/post-accept-main.js');
  const { policyPreset } = await import('../dist/autonomy-policy.js');
  const directory = mkdtempSync(join(tmpdir(), 'forge-review-wake-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = interceptSpawn(t);
  let data = {
    channelMoves: [],
    runs: [],
    checks: [],
    intents: [],
    views: [],
    autonomyPolicy: policyPreset('trusted'),
  };
  let observations = 0;
  const store = {
    directory,
    root: directory,
    load: () => {
      observations++;
      return structuredClone(data);
    },
    select: () => undefined,
  };
  wakePostAccept(store);
  data.channelMoves.push({
    id: 'new-acceptance',
    channel: 'main',
    status: 'accepted',
    postAccept: { checkId: 'verify' },
  });
  wakePostAccept(store);
  await tick();
  assert.equal(calls.length, 1, 'the pending wake starts the driver without an unrelated wake');
  assert.equal(observations, 2);
});

test('regression: GitHub controller diagnostics do not reset the audit stall timer', async t => {
  const { mkdirSync, writeFileSync, appendFileSync } = await import('node:fs');
  const { MainAuditWatchdog } = await import('../dist/post-accept-watchdog.js');
  const { readMainAuditState } = await import('../dist/post-accept-state.js');
  const directory = mkdtempSync(join(tmpdir(), 'forge-review-diagnostic-progress-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const store = { directory };
  const output = join(directory, 'check-audit');
  mkdirSync(output);
  writeFileSync(
    join(output, 'github-actions.json'),
    JSON.stringify({ commit: 'saved', runId: 1, states: { job: 'in_progress' } }),
  );
  const watchdog = new MainAuditWatchdog(store, 15 * 60_000);
  watchdog.update({
    channelMoves: [],
    runs: [
      {
        id: 'audit',
        status: 'running',
        mainCheck: { channel: 'main' },
        backend: { actual: 'github-actions' },
      },
    ],
    intents: [],
  });
  const began = Date.now();
  for (let i = 0; i < 14; i++) {
    t.mock.timers.tick(60_000);
    // launchGithubActionsRun.progress appends this diagnostic on every rate limit.
    appendFileSync(
      join(output, 'stdout.log'),
      'GitHub API rate limited; waiting 60 s for the budget, then continuing.\n',
    );
    watchdog.updateRuns();
  }
  assert.equal(Date.now() - began, 14 * 60_000);
  assert.equal(readMainAuditState(store).status, 'running');
  assert.equal(Date.parse(readMainAuditState(store).lastProgressAt), began);
  t.mock.timers.tick(60_000);
  appendFileSync(join(output, 'stdout.log'), 'GitHub API error 503; retrying.\n');
  assert.throws(() => watchdog.updateRuns(), { code: 'MAIN_AUDIT_STALLED' });
  assert.equal(readMainAuditState(store).status, 'stalled');
});

test('local command output keeps an active main audit progressing', async t => {
  const { MainAuditWatchdog } = await import('../dist/post-accept-watchdog.js');
  const { mkdirSync, appendFileSync } = await import('node:fs');
  const { readMainAuditState } = await import('../dist/post-accept-state.js');
  const directory = mkdtempSync(join(tmpdir(), 'forge-local-audit-progress-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'check-audit'));
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const store = { directory },
    watchdog = new MainAuditWatchdog(store, 1000);
  watchdog.update({
    channelMoves: [],
    intents: [],
    runs: [{ id: 'audit', status: 'running', mainCheck: { channel: 'main' }, backend: { actual: 'local' } }],
  });
  for (const file of ['stdout.log', 'stderr.log']) {
    t.mock.timers.tick(900);
    appendFileSync(join(directory, 'check-audit', file), 'command progress\n');
    watchdog.updateRuns();
    assert.equal(Date.parse(readMainAuditState(store).lastProgressAt), Date.now());
  }
  t.mock.timers.tick(1000);
  assert.throws(() => watchdog.updateRuns(), { code: 'MAIN_AUDIT_STALLED' });
});
