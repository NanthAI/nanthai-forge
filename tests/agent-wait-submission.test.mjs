// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './landing-batch-fixture.mjs';
import { gatedFixture } from './landing-worker-fixture.mjs';
import { agentWait } from '../dist/agent-wait.js';
import { watchLandingWorker } from '../dist/landing-worker.js';
import { watcherRuntime } from '../dist/local-watcher.js';
import { FakeWatchWorker } from './local-watcher-fixture.mjs';
import { landingWorkerStates } from '../dist/landing-worker-status.js';
import { FinishJournal } from '../dist/agent-finish-journal.js';
import { checkEnvironment } from '../dist/check-environment.js';
import { waitObservation } from '../dist/agent-wait-observation.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, diagnostic = () => 'Expected synthetic worker progress') {
  const end = Date.now() + 15000;
  for (;;) {
    const value = read();
    if (value) return value;
    // A delayed timer can resume after both completion and the deadline. Read
    // durable progress at that boundary before declaring the worker stalled.
    if (Date.now() >= end) assert.fail(diagnostic());
    await delay(20);
  }
}
function worker(f) {
  const controller = new AbortController();
  const done = watchLandingWorker(f.store, controller.signal);
  return async () => {
    controller.abort();
    await done;
  };
}
function update(f, mutate) {
  f.store.locked(() => {
    const data = f.store.load();
    mutate(data);
    f.store.save(data);
  });
}

test('review is pending and historical exact acceptance settles operation and kept-open Lane', async t => {
  const f = await fixture(t, { remote: false });
  const c = await f.candidate('review.txt');
  update(f, data => {
    data.landingEntries[0].status = 'awaiting-review';
  });
  const first = await agentWait(f.store, { operationIds: [c.command.operationId], timeoutSeconds: 0 });
  assert.equal(first.status, 'timeout');
  assert.equal(first.targets[0].pendingReason, 'waiting-for-review');
  update(f, data => {
    data.channelMoves.push({
      id: randomUUID(),
      channel: 'main',
      viewId: c.view.id,
      head: c.view.head,
      previous: null,
      status: 'accepted',
      provenance: 'user-declared-local',
      at: new Date().toISOString(),
    });
  });
  const result = await agentWait(f.store, {
    operationIds: [c.command.operationId],
    laneIds: [c.lane.laneId],
    timeoutSeconds: 0,
  });
  assert.equal(result.successful, true);
  assert.ok(result.targets.every(s => s.status === 'landed'));
  assert.equal(result.targets[0].submissions[0].head, c.checkpoint.head);
  assert.equal(f.store.select('lanes', c.lane.laneId).state, 'active');
});

test('resume cursor deduplicates replay and reports transitions missed while disconnected', async t => {
  const f = await fixture(t, { remote: false });
  const c = await f.candidate('cursor.txt');
  const selection = { operationIds: [c.command.operationId], timeoutSeconds: 0 };
  const first = await agentWait(f.store, selection);
  const replay = [];
  const second = await agentWait(f.store, { ...selection, cursor: first.cursor }, e => replay.push(e));
  assert.deepEqual(
    replay.map(e => e.type),
    ['summary'],
  );
  assert.equal(second.cursor, first.cursor);
  const stop = worker(f);
  try {
    await until(() => f.store.select('landingEntries', c.command.operationId).status === 'accepted');
  } finally {
    await stop();
  }
  const events = [];
  const resumed = await agentWait(f.store, { ...selection, cursor: second.cursor, until: 'any-change' }, e =>
    events.push(e),
  );
  assert.equal(resumed.status, 'terminal');
  assert.equal(resumed.successful, true);
  assert.equal(events.filter(e => e.type === 'submission' && e.status === 'landed').length, 1);
  assert.ok(events.every(e => typeof e.cursor === 'string'));
  const again = [];
  await agentWait(f.store, { ...selection, cursor: resumed.cursor }, e => again.push(e));
  assert.deepEqual(
    again.map(e => e.type),
    ['summary'],
  );
});

test('event cursor resumes after abrupt observer disconnect without repeating its event', async t => {
  const f = await fixture(t, { remote: false });
  const c = await f.candidate('disconnect.txt');
  let cursor;
  await assert.rejects(
    agentWait(f.store, { operationIds: [c.command.operationId] }, e => {
      if (e.type === 'submission') {
        cursor = e.cursor;
        throw new Error('Synthetic disconnect');
      }
    }),
    /Synthetic disconnect/,
  );
  const events = [];
  const before = f.store.pointer();
  await agentWait(f.store, { operationIds: [c.command.operationId], cursor, timeoutSeconds: 0 }, e =>
    events.push(e),
  );
  assert.equal(events.filter(e => e.type === 'submission').length, 0);
  assert.deepEqual(f.store.pointer(), before);
  assert.equal(f.store.select('landingEntries', c.command.operationId).status, 'queued');
});

test('cursor selection and decoding errors are explicit; reordered duplicate selections resume', async t => {
  const f = await fixture(t, { remote: false });
  const c = await f.candidate('scope.txt');
  const ids = [c.command.operationId, randomUUID()];
  const first = await agentWait(f.store, { operationIds: ids, timeoutSeconds: 0 });
  await assert.rejects(agentWait(f.store, { operationIds: [randomUUID()], cursor: first.cursor }), {
    code: 'BAD_ARGUMENT',
  });
  await assert.rejects(agentWait(f.store, { operationIds: ids, cursor: 'invalid' }), {
    code: 'BAD_ARGUMENT',
  });
  const events = [];
  await agentWait(
    f.store,
    { operationIds: [ids[1], ids[0], ids[0]], cursor: first.cursor, timeoutSeconds: 0 },
    e => events.push(e),
  );
  assert.deepEqual(
    events.map(e => e.type),
    ['summary'],
  );
});

test('one wait follows multiple operations across owner worker shutdown and restart', async t => {
  // A fixed-duration check can finish while the parent is busy reading Work.
  // Hold execution until shutdown/restart has been observed instead.
  const f = await gatedFixture(t);
  const a = await f.candidate('restart-a.txt'),
    b = await f.candidate('restart-b.txt');
  const events = [];
  const controller = new AbortController();
  const stop = worker(f);
  let restart, wait, result, waitError;
  const diagnostic = phase => () => {
    const data = f.store.load();
    return JSON.stringify({
      phase,
      summary: result,
      workers: landingWorkerStates(f.store).map(({ id, status, code }) => ({ id, status, code })),
      entries: data.landingEntries.map(({ id, status, batchId, runId }) => ({ id, status, batchId, runId })),
      batches: data.landingBatches?.map(({ id, status, prefixes }) => ({ id, status, prefixes })),
      runs: data.runs.map(({ id, status, cancellation }) => ({ id, status, cancellation })),
      events: events.map(({ type, id, status, runId }) => ({ type, id, status, runId })),
    });
  };
  try {
    await until(() => f.started, diagnostic('gated command started'));
    const run = f.store.load().runs.find(r => !r.mainCheck && r.status === 'running');
    assert.ok(run, 'the gated command is running before shutdown');
    const originalWorker = landingWorkerStates(f.store).find(s => s.status !== 'stopped');
    assert.ok(originalWorker);
    // Observe the gated run before stopping its controller. Preparation and
    // recovery have separate progress bounds, not one end-to-end API deadline.
    // The single observer remains live through every phase; cleanup aborts it.
    wait = agentWait(
      f.store,
      { operationIds: [a.command.operationId, b.command.operationId] },
      e => events.push(e),
      controller.signal,
    ).then(
      value => {
        result = value;
        return value;
      },
      error => {
        waitError = error;
      },
    );
    // Starting the command precedes publication of every entry's run pins.
    // Keep the command gated until this one observer has delivered both states;
    // no scheduler can guarantee they already existed on its first snapshot.
    await until(() => {
      if (waitError) throw waitError;
      const has = (type, id, status) =>
        events.some(e => e.type === type && e.id === id && e.status === status);
      return (
        has('check', run.id, 'running') &&
        has('operation', a.command.operationId, 'checking') &&
        has('operation', b.command.operationId, 'queued')
      );
    }, diagnostic('single observer delivered the running check and both operations'));
    await stop();
    assert.equal(f.store.select('runs', run.id).status, 'running');
    assert.equal(f.store.select('runs', run.id).cancellation, undefined);
    assert.equal(result, undefined, 'the same observer is pending while the worker is stopped');
    assert.equal(waitError, undefined);
    restart = worker(f);
    await until(
      () => landingWorkerStates(f.store).find(s => s.id !== originalWorker.id && s.status === 'idle'),
      diagnostic('replacement worker reconciled'),
    );
    assert.equal(f.store.select('runs', run.id).status, 'running');
    assert.equal(f.store.select('runs', run.id).cancellation, undefined);
    assert.equal(f.store.load().runs.filter(r => !r.mainCheck).length, 1, 'restart adopts the original run');
    assert.equal(result, undefined, 'recovery does not settle the still-gated check');
    f.release();
    // Command completion, acceptance publication and observer delivery have
    // independent progress bounds. A loaded owner can spend the whole delivery
    // window preparing acceptance; begin that window at its durable boundary.
    await until(
      () => f.store.select('runs', run.id).status === 'passed',
      diagnostic('gated command completed'),
    );
    // Then b's solo check and the combined gate run; each is its own durable step.
    const passed = () => f.store.load().runs.filter(r => !r.mainCheck && r.status === 'passed').length;
    await until(() => passed() >= 2, diagnostic('second solo check completed'));
    await until(() => passed() >= 3, diagnostic('combined check completed'));
    await until(
      () => [a, b].every(c => f.store.select('landingEntries', c.command.operationId).status === 'accepted'),
      diagnostic('replacement worker published acceptance'),
    );
    await until(() => {
      if (waitError) throw waitError;
      return result;
    }, diagnostic('single observer settled after acceptance'));
    assert.equal(result.successful, true, JSON.stringify(result));
    assert.equal(result.targets.length, 2);
    assert.equal(f.store.select('runs', run.id).status, 'passed');
    for (const c of [a, b]) {
      const entry = f.store.select('landingEntries', c.command.operationId);
      assert.equal(entry.status, 'accepted');
      const acceptedRun = f.store.select('runs', entry.runId);
      assert.equal(acceptedRun.status, 'passed');
      assert.equal(acceptedRun.inputs.length, 2, 'green inputs share the final combined gate');
      assert.equal(acceptedRun.head, f.store.select('channelMoves', entry.acceptanceId).head);
    }
    assert.equal(
      f.store.load().runs.filter(r => !r.mainCheck).length,
      3,
      'two solo checks and a combined check',
    );
    assert.equal(
      new Set(events.filter(e => e.type === 'submission' && e.status === 'landed').map(e => e.id)).size,
      2,
    );
    const keys = events
      .filter(e => e.type !== 'summary')
      .map(({ cursor, ...event }) => JSON.stringify(event));
    assert.equal(new Set(keys).size, keys.length);
  } finally {
    f.release();
    controller.abort();
    await stop();
    await restart?.();
    await wait;
  }
});

for (const [status, cause] of [
  ['failed', 'check-failed'],
  ['interrupted', 'infra'],
]) {
  test(`submission observes ${status} receipt before driver publication with pinned logs and S01 cause`, async t => {
    const f = await fixture(t, { remote: false });
    const c = await f.candidate(`${status}.txt`);
    const runId = randomUUID();
    const journal = new FinishJournal(f.store, c.command, c.checkpoint.head);
    journal.state.attempts[0].operations.run = runId;
    journal.save();
    update(f, data => {
      data.runs.push({
        id: runId,
        viewId: c.view.id,
        head: c.view.head,
        base: c.view.base,
        inputs: c.view.inputs,
        dependencies: [],
        check: data.checks[0],
        environment: checkEnvironment(),
        status: 'running',
        startedAt: new Date().toISOString(),
        runner: { pid: process.pid, host: hostname() },
        details: 'Synthetic run',
      });
      data.landingEntries[0].runId = runId;
      data.landingEntries[0].status = 'checking';
    });
    const path = join(f.store.directory, `check-${runId}`);
    mkdirSync(path);
    writeFileSync(join(path, 'stdout.log'), 'Synthetic diagnostic\n');
    writeFileSync(
      join(path, 'result.json'),
      JSON.stringify({
        status,
        endedAt: new Date().toISOString(),
        details: 'Synthetic cause',
        ...(status === 'failed' ? { exitCode: 1 } : {}),
      }),
    );
    const before = f.store.pointer();
    const result = await agentWait(f.store, { operationIds: [c.command.operationId], timeoutSeconds: 0 });
    const s = result.targets[0].submissions[0];
    assert.equal(result.status, 'terminal');
    assert.equal(result.successful, false);
    assert.equal(s.state, 'terminal-failed');
    assert.equal(s.cause, cause);
    assert.equal(s.runId, runId);
    assert.equal(s.reason, 'Synthetic cause');
    assert.equal(s.logPath, join(path, 'stdout.log'));
    assert.equal(s.head, c.checkpoint.head);
    assert.deepEqual(f.store.pointer(), before);
  });
}

test('snapshot/register/reread catches completion published inside the first snapshot', async t => {
  const f = await fixture(t, { remote: false });
  const c = await f.candidate('reread.txt');
  const observing = f.store.observing.bind(f.store);
  let injected = false;
  f.store.observing = read => {
    const result = observing(read);
    if (!injected) {
      injected = true;
      update(f, data => {
        data.landingEntries[0].status = 'accepted';
      });
    }
    return result;
  };
  const result = await agentWait(f.store, { operationIds: [c.command.operationId], timeoutSeconds: 0 });
  assert.equal(result.successful, true);
});

test('new Lane save is not credited with an older submission, whose operation stays superseded', async t => {
  const f = await fixture(t, { remote: false });
  const c = await f.candidate('new-save.txt');
  writeFileSync(join(c.lane.path, 'new-save.txt'), 'newer\n');
  await f.agent.dispatch({ action: 'checkpoint', laneId: c.lane.laneId, message: 'New save' });
  const result = await agentWait(f.store, { operationIds: [c.command.operationId], timeoutSeconds: 0 });
  assert.equal(result.targets[0].status, 'superseded');
  assert.equal(result.successful, false);
  assert.equal(waitObservation(f.store, 'lane', c.lane.laneId).target.terminal, false);
});

test('missed filesystem notifications recover from saved state and duplicate wakes emit once', async t => {
  const f = await fixture(t, { remote: false });
  const c = await f.candidate('missed-wake.txt');
  t.mock.method(watcherRuntime, 'createWorker', () => new FakeWatchWorker({ code: 'EMFILE' }));
  const events = [];
  const wait = agentWait(
    f.store,
    { operationIds: [c.command.operationId], until: 'any-change', timeoutSeconds: 10 },
    e => events.push(e),
  );
  // Watchers are deliberately disconnected. Repeated durable writes are not new observations.
  update(f, () => {});
  update(f, () => {});
  update(f, data => {
    data.landingEntries[0].status = 'awaiting-review';
  });
  const result = await wait;
  assert.equal(result.status, 'changed');
  assert.equal(result.targets[0].pendingReason, 'waiting-for-review');
  assert.equal(events.filter(e => e.type === 'submission').length, 2);
});

test('selected finish review receipt follows later human acceptance without replaying finish', async t => {
  const f = await fixture(t, { remote: false });
  const c = await f.candidate('finish-review.txt', undefined, false);
  const journal = new FinishJournal(f.store, c.command, c.checkpoint.head);
  journal.state.attempts[0].view = { viewId: c.view.id };
  journal.state.result = { status: 'awaiting-review', terminal: false, complete: false };
  journal.save();
  const input = { operationIds: [c.command.operationId], timeoutSeconds: 0 };
  const pending = await agentWait(f.store, input);
  assert.equal(pending.targets[0].pendingReason, 'waiting-for-review');
  update(f, data =>
    data.channelMoves.push({
      id: randomUUID(),
      channel: 'main',
      viewId: c.view.id,
      head: c.view.head,
      previous: null,
      status: 'accepted',
      provenance: 'user-declared-local',
      at: new Date().toISOString(),
    }),
  );
  const result = await agentWait(f.store, { ...input, cursor: pending.cursor });
  assert.equal(result.successful, true);
  assert.equal(result.targets[0].submissions[0].attemptId, journal.state.attempts[0].operationId);
  assert.equal(f.store.load().runs.length, 0);
});

test('an ambiguous dispatch receipt stays pending-infra before and after Work publication without recovery writes', async t => {
  const f = await fixture(t, { remote: false });
  const c = await f.candidate('pending-infra.txt');
  const runId = randomUUID();
  const backend = { requested: 'github-actions', actual: 'github-actions', pin: 'a'.repeat(64) };
  const error = { code: 'GITHUB_ACTIONS_PENDING_INFRA', message: 'original dispatch still undiscovered' };
  update(f, data => {
    data.runs.push({
      id: runId,
      viewId: c.view.id,
      head: c.view.head,
      base: c.view.base,
      inputs: c.view.inputs,
      dependencies: [],
      check: data.checks[0],
      environment: checkEnvironment(),
      status: 'running',
      startedAt: new Date().toISOString(),
      runner: { pid: process.pid, host: hostname() },
      backend,
      details: 'Synthetic Actions run',
    });
    data.landingEntries[0].runId = runId;
    data.landingEntries[0].status = 'checking';
  });
  const path = join(f.store.directory, `check-${runId}`);
  mkdirSync(path);
  writeFileSync(
    join(path, 'result.json'),
    JSON.stringify({
      status: 'interrupted',
      backend,
      error,
      endedAt: new Date().toISOString(),
      details: error.message,
    }),
  );
  for (const published of [false, true]) {
    if (published)
      update(f, data => {
        Object.assign(data.runs[0], { status: 'interrupted', error });
      });
    const before = f.store.pointer();
    const result = await agentWait(f.store, {
      operationIds: [c.command.operationId, runId],
      timeoutSeconds: 0,
    });
    assert.equal(result.status, 'timeout');
    assert.ok(result.targets.every(target => !target.terminal));
    assert.ok(result.targets.every(target => target.status === 'pending-infra'));
    const submission = result.targets[0].submissions[0];
    assert.equal(submission.pendingReason, 'pending-infra');
    assert.equal(submission.cause, null);
    assert.equal(submission.runId, runId);
    assert.equal(submission.logPath, null);
    assert.match(submission.providerUrl, /^https:\/\/github.com\//);
    assert.deepEqual(f.store.pointer(), before);
  }
});
