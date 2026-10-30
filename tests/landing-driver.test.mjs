// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture } from './landing-batch-fixture.mjs';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { batchEdit, selectBatch, composeBatch } from '../dist/landing-batch-store.js';
import { claimLandingDriver } from '../dist/landing-driver.js';
import { advanceLandingBatch, batchAcceptanceId } from '../dist/landing-batch-step.js';
import { drainLandingBatches } from '../dist/landing-batch.js';
import { drainPostAccept } from '../dist/post-accept-main.js';
import { readLaneSubmissions } from '../dist/landing-submission-read.js';
import { ForgeError } from '../dist/errors.js';
import { landingBatchSchema } from '../dist/landing-batch-types.js';
import { preserveFields } from '../dist/work-normalization.js';

const select = f => batchEdit(f.work, 'test-select', data => selectBatch(f.work, data, 'main'));
const runs = f => f.store.load().runs.filter(run => !run.mainCheck && !f.soloRuns.has(run.id));
const snapshot = f => ({
  batches: f.store.load().landingBatches,
  runs: runs(f),
  moves: f.store.load().channelMoves,
});
const interrupted = () => new ForgeError('SYNTHETIC_EXIT', 'Synthetic driver exit after durable publication');

for (const phase of ['selection', 'compose'])
  test(`process exit after ${phase} resumes the same batch and exact prefix identities`, async t => {
    const f = await fixture(t);
    const input = await f.candidate(`${phase}.txt`);
    const script = `import { AgentWorkflow } from ${JSON.stringify(new URL('../dist/agent-workflow.js', import.meta.url).href)};
import { batchEdit, selectBatch, composeBatch } from ${JSON.stringify(new URL('../dist/landing-batch-store.js', import.meta.url).href)};
const work = new AgentWorkflow(process.argv[1]).work;
const batch = await batchEdit(work, 'crash-selection', data => selectBatch(work, data, 'main'));
if (process.argv[2] === 'compose') await composeBatch(work, batch);
process.exit(79);`;
    await assert.rejects(
      promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, f.root, phase]),
      { code: 79 },
    );
    const selected = f.store.load().landingBatches[0];
    const submission = readLaneSubmissions(f.store, input.lane.laneId)[0];
    assert.equal(submission.state, 'pending');
    assert.equal(submission.pendingReason, 'checking');
    await drainLandingBatches(new AgentWorkflow(f.root).work, 'main');
    const data = f.store.load(),
      final = readLaneSubmissions(f.store, input.lane.laneId)[0];
    assert.equal(data.landingBatches.length, 1);
    assert.equal(data.landingBatches[0].id, selected.id);
    if (phase === 'compose') {
      assert.deepEqual(
        data.landingBatches[0].prefixes.map(({ reservedAt, ...pins }) => pins),
        selected.prefixes,
      );
      assert(data.landingBatches[0].prefixes.every(prefix => Number.isFinite(Date.parse(prefix.reservedAt))));
    }
    assert.equal(runs(f).length, 1);
    assert.equal(data.channelMoves.length, 1);
    assert.equal(final.submissionId, submission.submissionId);
    assert.equal(final.attemptId, submission.attemptId);
    assert.equal(final.head, input.checkpoint.head);
    assert.equal(final.state, 'landed');
  });

test('exit after check reservation adopts the retained run rather than dispatching a new operation', async t => {
  const f = await fixture(t, { delay: 300 });
  await f.candidate('reserved.txt');
  const dispatch = f.work.dispatch.bind(f.work);
  let runId;
  f.work.dispatch = async (...args) => {
    const response = await dispatch(...args);
    if (args[0].action === 'run-check') {
      runId = args[0].operationId;
      throw interrupted();
    }
    return response;
  };
  await assert.rejects(drainLandingBatches(f.work, 'main'), { code: 'SYNTHETIC_EXIT' });
  assert.equal(runs(f).length, 1);
  await drainLandingBatches(new AgentWorkflow(f.root).work, 'main');
  assert.equal(runs(f).length, 1);
  assert.equal(runs(f)[0].id, runId);
  assert.equal(f.store.load().landingEntries[0].runId, runId);
  assert.equal(f.store.load().landingEntries[0].status, 'accepted');
});

test('durable evaluation resumes acceptance without calling run-check again', async t => {
  const f = await fixture(t);
  await f.candidate('evaluation.txt');
  const batch = await select(f),
    driver = await claimLandingDriver(f.work, 'main');
  assert.equal(await advanceLandingBatch(f.work, batch.id, driver), 'advanced'); // compose
  assert.equal(await advanceLandingBatch(f.work, batch.id, driver), 'advanced'); // evaluate
  const saved = f.store.select('landingBatches', batch.id);
  assert.equal(saved.settlement.passingViewId, saved.prefixes[0].viewId);
  const replacement = new AgentWorkflow(f.root).work,
    dispatch = replacement.dispatch.bind(replacement);
  replacement.dispatch = (...args) => {
    assert.notEqual(args[0].action, 'run-check');
    return dispatch(...args);
  };
  await drainLandingBatches(replacement, 'main');
  assert.equal(runs(f).length, 1);
  assert.equal(f.store.load().channelMoves.length, 1);
});

for (const fastPath of [false, true])
  test(`lost acceptance receipt reconciles after later main movement (${fastPath ? 'disjoint acceptance' : 'exact acceptance'})`, async t => {
    const f = await fixture(t);
    await f.candidate('receipt.txt');
    const batch = await select(f);
    const dispatch = f.work.dispatch.bind(f.work);
    let accepted = false;
    f.work.dispatch = async (...args) => {
      const response = await dispatch(...args);
      if (args[0].action === 'accept-channel' && !accepted) {
        accepted = true;
        throw interrupted();
      }
      return response;
    };
    if (fastPath) {
      const person = new (await import('../dist/work.js')).WorkService(f.root);
      await person.dispatch(
        {
          action: 'set-policy',
          operationId: (await import('node:crypto')).randomUUID(),
          acceptance: { disjointFastPath: true },
        },
        person.store.revision(),
      );
      const rival = await f.candidate('overtake.txt', 'overtake\n', false);
      await person.dispatch(
        {
          action: 'accept-channel',
          operationId: (await import('node:crypto')).randomUUID(),
          channel: 'main',
          viewId: rival.view.id,
          expectedHead: rival.view.head,
          expectedPrevious: null,
        },
        person.store.revision(),
        { keepOpen: true },
      );
    }
    await assert.rejects(drainLandingBatches(f.work, 'main'), { code: 'SYNTHETIC_EXIT' });
    await drainPostAccept(f.store);
    const before = snapshot(f),
      receipt = before.moves.at(-1);
    if (fastPath) assert.equal(receipt.fastPath.kind, 'disjoint-fast-path');
    // Another independent accepted Candidate moves main after the lost receipt.
    const rival = await f.candidate('after-receipt.txt', 'later\n', false);
    const person = new (await import('../dist/work.js')).WorkService(f.root);
    const move = await person.dispatch(
      {
        action: 'accept-channel',
        operationId: (await import('node:crypto')).randomUUID(),
        channel: 'main',
        viewId: rival.view.id,
        expectedHead: rival.view.head,
        expectedPrevious: receipt.head,
      },
      person.store.revision(),
      { keepOpen: true },
    );
    // Controller upgrades must not turn an accepted operation into an interruption.
    await batchEdit(f.work, 'old-controller', data => {
      data.landingEntries[0].runtimeSnapshot.cli = 'synthetic-prior-controller';
    });
    const replacement = new AgentWorkflow(f.root).work,
      replay = replacement.dispatch.bind(replacement);
    replacement.dispatch = (...args) => {
      assert.notEqual(args[0].action, 'run-check');
      return replay(...args);
    };
    await drainLandingBatches(replacement, 'main');
    assert.equal(runs(f).length, 1);
    assert.equal(f.store.load().channelMoves.length, before.moves.length + 1);
    assert.equal(f.main().head, move.result.head);
    assert.equal(f.store.select('landingBatches', batch.id).acceptanceId, receipt.id);
    assert.equal(f.store.load().landingEntries[0].status, 'accepted');
  });

test('a second drain observes the existing queue holder without claiming a generation or writing Work', async t => {
  const f = await fixture(t);
  await f.candidate('duplicate.txt');
  let reached, release;
  const ready = new Promise(resolve => {
    reached = resolve;
  });
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const first = drainLandingBatches(f.work, 'main', undefined, async () => {
    reached();
    await gate;
  });
  await ready;
  const revision = f.store.revision();
  try {
    const result = await drainLandingBatches(new AgentWorkflow(f.root).work, 'main', 0);
    assert.ok(result.waiting);
    assert.equal(f.store.revision(), revision);
    assert.equal(runs(f).length, 1);
  } finally {
    release();
    await first;
  }
  assert.equal(f.store.load().channelMoves.length, 1);
});

test('replacement generation fences composition, check reservation, settlement and acceptance inside publication locks', async t => {
  const f = await fixture(t);
  await f.candidate('fence.txt');
  const batch = await select(f),
    old = await claimLandingDriver(f.work, 'main');
  let current = await claimLandingDriver(f.work, 'main');
  assert.equal(current.generation, old.generation + 1);
  const revision = f.store.revision();
  await assert.rejects(composeBatch(f.work, batch, old.beforePublish), { code: 'LANDING_DRIVER_STALE' });
  assert.equal(f.store.revision(), revision);
  await advanceLandingBatch(f.work, batch.id, current);
  const dispatch = f.work.dispatch.bind(f.work);
  let replace = true;
  f.work.dispatch = async (...args) => {
    if (replace && args[0].action === 'run-check') {
      replace = false;
      await claimLandingDriver(f.work, 'main');
    }
    return dispatch(...args);
  };
  await assert.rejects(advanceLandingBatch(f.work, batch.id, current), { code: 'LANDING_DRIVER_STALE' });
  assert.equal(runs(f).length, 0);
  current = await claimLandingDriver(f.work, 'main');
  await advanceLandingBatch(f.work, batch.id, current);
  const before = snapshot(f);
  f.work.dispatch = async (...args) => {
    if (args[0].action === 'accept-channel') await claimLandingDriver(f.work, 'main');
    return dispatch(...args);
  };
  await assert.rejects(advanceLandingBatch(f.work, batch.id, current), { code: 'LANDING_DRIVER_STALE' });
  assert.deepEqual(snapshot(f), before);
  f.work.dispatch = dispatch;
  await drainLandingBatches(f.work, 'main');
  assert.equal(runs(f).length, 1);
  assert.equal(f.store.load().channelMoves.length, 1);
});

test('late original check evidence survives a driver replacement while stale settlement is fenced', async t => {
  const f = await fixture(t, { delay: 300 });
  await f.candidate('late.txt');
  const batch = await select(f),
    driver = await claimLandingDriver(f.work, 'main');
  await advanceLandingBatch(f.work, batch.id, driver);
  const dispatch = f.work.dispatch.bind(f.work);
  f.work.dispatch = async (...args) => {
    const response = await dispatch(...args);
    if (args[0].action === 'run-check') await claimLandingDriver(f.work, 'main');
    return response;
  };
  await assert.rejects(advanceLandingBatch(f.work, batch.id, driver), { code: 'LANDING_DRIVER_STALE' });
  assert.equal(runs(f)[0].status, 'passed');
  assert.equal(f.store.select('landingBatches', batch.id).settlement, undefined);
  await drainLandingBatches(new AgentWorkflow(f.root).work, 'main');
  assert.equal(runs(f).length, 1);
  assert.equal(f.store.load().landingEntries[0].status, 'accepted');
});

test('legacy writers preserve optional evaluation state before completion results promote the Work format', async t => {
  const f = await fixture(t);
  await f.candidate('compatible.txt');
  const batch = await select(f),
    driver = await claimLandingDriver(f.work, 'main');
  await advanceLandingBatch(f.work, batch.id, driver);
  await advanceLandingBatch(f.work, batch.id, driver);
  const saved = f.store.select('landingBatches', batch.id);
  const legacy = landingBatchSchema.omit({ settlement: true });
  assert.deepEqual(preserveFields(legacy.parse(saved), saved), saved);
  const data = f.store.load();
  data.landingBatches[0] = preserveFields(legacy.parse(saved), saved);
  data.revision++;
  f.store.locked(() => f.store.save(data));
  assert.equal(f.store.load().schema, 24);
  await drainLandingBatches(f.work, 'main');
  assert.equal(f.main().id, batchAcceptanceId(batch, saved.prefixes[0].viewId));
  assert.equal(f.store.load().schema, 24);
});

test('at runner capacity repeated drain observations publish no unchanged Work', async t => {
  const f = await fixture(t);
  await f.agent.dispatch({
    action: 'set-policy',
    operationId: (await import('node:crypto')).randomUUID(),
    checks: { concurrency: 1 },
  });
  await f.candidate('capacity-first.txt');
  let reached, release;
  const ready = new Promise(resolve => {
    reached = resolve;
  });
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const driving = drainLandingBatches(f.work, 'main', undefined, async () => {
    reached();
    await gate;
  });
  await ready;
  const next = await f.candidate('capacity-next.txt');
  assert.equal(f.store.select('landingEntries', next.command.operationId).waitingFor.rule, 'capacity');
  const revision = f.store.revision(),
    readRecords = f.store.readRecords.bind(f.store),
    save = f.store.save.bind(f.store),
    commit = f.store.commitRecords.bind(f.store);
  let observations = 0,
    writes = 0,
    observed;
  const sampled = new Promise(resolve => {
    observed = resolve;
  });
  f.store.readRecords = () => {
    const data = readRecords();
    if (++observations >= 3) observed();
    return data;
  };
  f.store.save = data => {
    writes++;
    return save(data);
  };
  f.store.commitRecords = (...args) => {
    writes++;
    return commit(...args);
  };
  try {
    await sampled;
    assert.equal(writes, 0);
    assert.equal(f.store.revision(), revision);
  } finally {
    f.store.readRecords = readRecords;
    f.store.save = save;
    f.store.commitRecords = commit;
    release();
    await driving;
  }
  assert.ok(f.store.load().landingEntries.every(entry => entry.status === 'accepted'));
});

test('cancellation after durable evaluation invalidates that cursor and accepts only a freshly checked prefix', async t => {
  const f = await fixture(t);
  const first = await f.candidate('cancel-before.txt');
  const cancelled = await f.candidate('cancel-after.txt');
  await f.checkCandidates();
  const batch = await select(f),
    driver = await claimLandingDriver(f.work, 'main');
  await advanceLandingBatch(f.work, batch.id, driver);
  await advanceLandingBatch(f.work, batch.id, driver);
  await (
    await import('../dist/landing-batch-cancel.js')
  ).cancelLandingEntry(f.work, cancelled.command.operationId);
  await drainLandingBatches(f.work, 'main');
  assert.equal(f.store.select('landingEntries', first.command.operationId).status, 'accepted');
  assert.equal(f.store.select('landingEntries', cancelled.command.operationId).status, 'cancelled');
  assert.equal(f.content('cancel-after.txt'), undefined);
  assert.equal(runs(f).length, 2);
});

for (const kind of ['failed', 'review'])
  test(`S01 ${kind} observation retains submission and attempt identity across durable evaluation resume`, async t => {
    const f = await fixture(t);
    const input = await f.candidate(kind === 'failed' ? 'bad.txt' : 'review-resume.txt');
    const batch = await select(f),
      driver = await claimLandingDriver(f.work, 'main');
    const initial = readLaneSubmissions(f.store, input.lane.laneId)[0];
    await advanceLandingBatch(f.work, batch.id, driver);
    await advanceLandingBatch(f.work, batch.id, driver);
    if (kind === 'review') {
      const person = new (await import('../dist/work.js')).WorkService(f.root);
      await person.dispatch(
        {
          action: 'set-policy',
          operationId: (await import('node:crypto')).randomUUID(),
          preset: 'supervised',
        },
        person.store.revision(),
      );
    }
    await drainLandingBatches(new AgentWorkflow(f.root).work, 'main');
    const final = readLaneSubmissions(f.store, input.lane.laneId)[0];
    assert.equal(final.submissionId, initial.submissionId);
    assert.equal(final.attemptId, initial.attemptId);
    assert.equal(final.head, initial.head);
    assert.equal(final.complete, false);
    assert.equal(final.state, kind === 'failed' ? 'terminal-failed' : 'pending');
    assert.equal(final.cause, kind === 'failed' ? 'check-failed' : null);
    assert.equal(final.pendingReason, kind === 'failed' ? null : 'waiting-for-review');
    assert.equal(runs(f).length, 1);
  });

test('legacy shorter-prefix acceptance without an evaluation cursor retains its exact failed successor', async t => {
  const f = await fixture(t, { failWhen: "exists('legacy-good.txt') && exists('bad.txt')" });
  const good = await f.candidate('legacy-good.txt'),
    bad = await f.candidate('bad.txt');
  await f.checkCandidates();
  const batch = await select(f);
  const dispatch = f.work.dispatch.bind(f.work);
  f.work.dispatch = async (...args) => {
    const response = await dispatch(...args);
    if (args[0].action === 'accept-channel') throw interrupted();
    return response;
  };
  await assert.rejects(drainLandingBatches(f.work, 'main'), { code: 'SYNTHETIC_EXIT' });
  await drainPostAccept(f.store);
  await batchEdit(f.work, 'legacy-cursor', data => {
    delete data.landingBatches[0].settlement;
  });
  const replacement = new AgentWorkflow(f.root).work,
    replay = replacement.dispatch.bind(replacement);
  replacement.dispatch = (...args) => {
    assert.notEqual(args[0].action, 'run-check');
    return replay(...args);
  };
  await drainLandingBatches(replacement, 'main');
  assert.equal(f.store.select('landingEntries', good.command.operationId).status, 'accepted');
  assert.equal(f.store.select('landingEntries', bad.command.operationId).status, 'failed');
  assert.equal(f.store.select('landingBatches', batch.id).culpritId, bad.command.operationId);
  assert.equal(f.store.select('landingBatches', batch.id).confirmation.verdict, 'confirmed');
  assert.equal(runs(f).length, 3);
  assert.equal(f.store.load().channelMoves.length, 1);
});

test('a newer Lane save remains superseded when its original evaluated submission resumes', async t => {
  const f = await fixture(t);
  const input = await f.candidate('pinned.txt');
  const batch = await select(f),
    driver = await claimLandingDriver(f.work, 'main');
  const initial = readLaneSubmissions(f.store, input.lane.laneId)[0];
  await advanceLandingBatch(f.work, batch.id, driver);
  await advanceLandingBatch(f.work, batch.id, driver);
  const { writeFileSync } = await import('node:fs'),
    { join } = await import('node:path');
  writeFileSync(join(input.lane.path, 'pinned.txt'), 'newer save\n');
  const newer = (
    await f.agent.dispatch({
      action: 'checkpoint',
      laneId: input.lane.laneId,
      message: 'New save after evaluation',
    })
  ).result;
  await drainLandingBatches(new AgentWorkflow(f.root).work, 'main');
  const final = readLaneSubmissions(f.store, input.lane.laneId)[0];
  assert.equal(final.submissionId, initial.submissionId);
  assert.equal(final.attemptId, initial.attemptId);
  assert.equal(final.head, initial.head);
  assert.equal(final.state, 'superseded');
  assert.equal(final.outcome, 'terminal-failed');
  assert.equal(f.store.load().channelMoves.length, 0);
  assert.equal(final.complete, false);
  assert.equal(f.store.select('lanes', input.lane.laneId).head, newer.head);
  assert.equal(f.store.select('landingEntries', input.command.operationId).reason.includes(newer.head), true);
  assert.equal(runs(f).length, 1);
});

for (const status of ['conflict', 'cancelled'])
  test(`restart settles an unfinished batch when every entry is already ${status}`, async t => {
    const f = await fixture(t);
    const input = await f.candidate('same.txt', 'pending version\n');
    if (status === 'conflict') {
      const rival = await f.candidate('same.txt', 'accepted version\n', false);
      const person = new (await import('../dist/work.js')).WorkService(f.root);
      await person.dispatch(
        {
          action: 'accept-channel',
          operationId: (await import('node:crypto')).randomUUID(),
          channel: 'main',
          viewId: rival.view.id,
          expectedHead: rival.view.head,
          expectedPrevious: null,
        },
        person.store.revision(),
        { keepOpen: true },
      );
      await drainPostAccept(f.store);
    }
    const batch = await select(f);
    if (status === 'cancelled')
      await (
        await import('../dist/landing-batch-cancel.js')
      ).cancelLandingEntry(f.work, input.command.operationId);
    await composeBatch(f.work, batch);
    assert.equal(f.store.select('landingEntries', input.command.operationId).status, status);
    const before = snapshot(f);
    await drainLandingBatches(new AgentWorkflow(f.root).work, 'main');
    assert.equal(f.store.select('landingBatches', batch.id).status, 'completed');
    assert.equal(f.store.select('landingEntries', input.command.operationId).status, status);
    assert.deepEqual(runs(f), before.runs);
    assert.deepEqual(f.store.load().channelMoves, before.moves);
  });
