// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const redrive = await import(moduleUrl('../convex/projectHostedLandingRedrive.ts'));
const windowApi = await import(moduleUrl('../convex/projectLegacyStorageWindow.ts'));

const deployment = 'dev:synthetic-outage';
const environment = { ...synthetic, CONVEX_CLOUD_URL: 'https://synthetic-outage.convex.cloud' };
const prior = Object.fromEntries(
  [...Object.keys(environment), 'FORGE_LEGACY_STORAGE_PAUSE'].map(k => [k, process.env[k]]),
);
test.before(() => Object.assign(process.env, environment));
test.afterEach(() => delete process.env.FORGE_LEGACY_STORAGE_PAUSE);
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const OUTAGE_MS = 20 * 60_000;
const terminal = s => s.phase === 'landed' || s.phase === 'terminal-failed';
/** Pass every check and run steps until the entry is Ready (settling). */
async function untilReady(f) {
  for (let tick = 0; states(f)[0].phase !== 'ready'; tick++) {
    assert(tick < 200, states(f)[0].phase);
    for (const run of f.runs().filter(run => run.status === 'queued'))
      await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    await f.execute(f.pending()[0]);
  }
}

/** Issue 72d50375: the dev storage pause refuses every write for up to 30 min.
 * A scheduled settlement step or stall alarm that fires then throws; Convex does
 * not retry it and the row keeps pointing at the failed task. This replays an
 * N-minute outage in the middle of CI or of settlement, then ends it the way
 * it really ends, and requires every landing to finish with no operator action. */
async function replay(t, { during, resume }) {
  const f = await batchesFixture(t, { count: 3, batching: false, requestCheck: true });
  const operationId = randomUUID();
  let pause = null,
    resumed = false,
    lostTasks = 0,
    redrives = [];
  const held = new Map(); // runner-side results kept while writes are refused
  const begin = async () => {
    const now = Date.now();
    pause = { deployment, operationId, startedAt: now, expiresAt: now + OUTAGE_MS };
    process.env.FORGE_LEGACY_STORAGE_PAUSE = JSON.stringify(pause);
    await f.transaction('windowBegin', windowApi.begin, { operationId });
  };
  const paused = () => pause && !resumed;
  const mark = (task, kind) => f.patch('_scheduled_functions', task._id, { state: { kind } });
  const run = async task => {
    if (task.name === 'projectHostedLandingRedrive:sweep') {
      f.advanceClock(Math.max(0, task.scheduledTime - Date.now()));
      mark(task, 'inProgress');
      try {
        await f.transaction('redriveSweep', redrive.sweep, task.args[0]);
      } catch (error) {
        mark(task, 'failed');
        throw error;
      }
      return mark(task, 'success');
    }
    if (task.name === 'projectHostedLandingRedrive:resume') {
      f.advanceClock(Math.max(0, task.scheduledTime - Date.now()));
      mark(task, 'inProgress');
      await redrive.resume._handler(
        {
          scheduler: {
            runAfter: (delay, ref, args) =>
              f.transaction(
                'resumeSchedule',
                { _handler: ctx => ctx.scheduler.runAfter(delay, ref, args) },
                {},
              ),
          },
          runMutation: (_, args) => f.transaction('redriveSweep', redrive.sweep, args),
        },
        {},
      );
      return mark(task, 'success');
    }
    return f.execute(task);
  };
  for (let tick = 0; ; tick++) {
    assert(tick < 1500, JSON.stringify(states(f).map(s => [s.sequence, s.phase])));
    // A runner starts only while writes are accepted; a finished result is
    // kept until Forge accepts it (the HTTP retry window is covered by
    // hosted-actions-retry.test.mjs). That retention is what carries the CI
    // case: its result lands after the outage and drives the queue again.
    if (!paused())
      for (const run of f.runs().filter(run => run.status === 'queued' && !held.has(run.id)))
        held.set(run.id, await f.rawChecks.activate(run.id));
    if (during === 'ci' && !pause && held.size) await begin();
    if (!paused())
      for (const [id, activated] of held) {
        await f.rawChecks.pass(activated);
        held.delete(id);
      }
    if (during === 'settlement' && !pause && states(f).some(s => s.phase === 'ready')) await begin();
    const task = f.pending()[0];
    if (paused() && (!task || task.scheduledTime >= pause.expiresAt)) {
      // The outage ends. Either the operator closes the window and then
      // removes the flag, or the window simply expires.
      f.advanceClock(Math.max(0, pause.expiresAt - 60_000 - Date.now()));
      if (resume === 'operator') {
        await f.transaction('windowEnd', windowApi.end, { operationId });
        // A resume check while the flag is still set waits; then the flag goes.
        await run(f.pending().find(task => task.name === 'projectHostedLandingRedrive:resume'));
        delete process.env.FORGE_LEGACY_STORAGE_PAUSE;
      } else f.advanceClock(Math.max(0, pause.expiresAt + 1 - Date.now()));
      resumed = true;
      if (resume === 'reader') {
        // Nothing else writes: a waiting reader whose entry stays Ready with no
        // new version asks once (src/hosted-landing-redrive.ts). That write also
        // closes the expired window and schedules the sweep.
        for (const state of states(f).filter(s => s.phase === 'ready')) {
          const reply = JSON.parse(
            await f.transaction('redrive', redrive.redrive, {
              projectId: f.projectId,
              submissionId: state.id,
            }),
          );
          redrives.push({ id: state.id, redriven: reply.redriven });
        }
      }
      continue;
    }
    if (!task) break;
    try {
      await run(task);
    } catch (error) {
      if (!paused()) throw error;
      assert.match(String(error?.code ?? error?.message), /LEGACY_STORAGE_WRITES_PAUSED|paused/);
      assert.equal(f.tables._scheduled_functions.get(task._id).state.kind, 'failed');
      lostTasks++;
    }
    if (states(f).every(terminal) && !held.size) break;
  }
  return { f, lostTasks, redrives, resumed };
}

for (const during of ['settlement', 'ci'])
  test(`a ${OUTAGE_MS / 60_000}-minute write outage during ${during}: every landing lands once the operator resumes writes`, async t => {
    const { f, lostTasks, resumed } = await replay(t, { during, resume: 'operator' });
    assert(resumed, 'the replay reached the outage');
    assert(lostTasks > 0, 'scheduled steps failed during the outage');
    assert.deepEqual(
      states(f).map(s => s.phase),
      ['landed', 'landed', 'landed'],
      'every landing finishes with no operator action on the queue',
    );
    const window = [...f.tables.legacyStorageCleanupWindows.values()][0];
    assert.equal(window.active, false, 'the operator closed the fence');
  });

test('a write outage that just expires: the waiting reader of a quiet Ready entry asks once and it lands', async t => {
  const { f, lostTasks, redrives } = await replay(t, { during: 'settlement', resume: 'reader' });
  assert(lostTasks > 0, 'scheduled steps failed during the outage');
  assert(redrives.length >= 1, 'a waiting reader had a quiet settling entry');
  assert(
    redrives.every(r => r.redriven.length > 0),
    JSON.stringify(redrives),
  );
  assert.deepEqual(
    states(f).map(s => s.phase),
    ['landed', 'landed', 'landed'],
  );
  assert.equal(
    [...f.tables.legacyStorageCleanupWindows.values()][0].active,
    false,
    'the first resumed write closed the expired fence and scheduled the sweep',
  );
});

test('without a re-drive the same outage strands a passed landing (the bug this guards)', async t => {
  const f = await batchesFixture(t, { count: 1, batching: false, requestCheck: true });
  const operationId = randomUUID();
  await untilReady(f);
  const now = Date.now();
  process.env.FORGE_LEGACY_STORAGE_PAUSE = JSON.stringify({
    deployment,
    operationId,
    startedAt: now,
    expiresAt: now + OUTAGE_MS,
  });
  let lost = 0;
  for (let task = f.pending()[0]; task && task.scheduledTime < now + OUTAGE_MS; task = f.pending()[0])
    await f.execute(task).catch(() => lost++);
  delete process.env.FORGE_LEGACY_STORAGE_PAUSE;
  assert(lost > 0);
  const [state] = states(f);
  assert.equal(state.phase, 'ready', 'the passed entry waits to settle');
  assert(
    !f.pending().some(task => task.args[0]?.submissionId === state.id),
    'nothing is left to drive it: the stall shape of c329d191',
  );
  // The re-drive replays exactly the lost steps, and only once.
  const first = JSON.parse(
    await f.transaction('redrive', redrive.redrive, { projectId: f.projectId, submissionId: state.id }),
  );
  assert(first.redriven.includes('finish'), JSON.stringify(first));
  const again = JSON.parse(
    await f.transaction('redrive', redrive.redrive, { projectId: f.projectId, submissionId: state.id }),
  );
  assert.deepEqual(again.redriven, [], 'a repeated re-drive schedules nothing new');
  await f.drain();
  assert.equal(states(f)[0].phase, 'landed');
});

test('a re-drive during the outage is refused with a retry time and changes nothing', async t => {
  const f = await batchesFixture(t, { count: 1, batching: false, requestCheck: true });
  await untilReady(f);
  const now = Date.now();
  process.env.FORGE_LEGACY_STORAGE_PAUSE = JSON.stringify({
    deployment,
    operationId: randomUUID(),
    startedAt: now,
    expiresAt: now + OUTAGE_MS,
  });
  // The settlement step fires inside the outage and is lost.
  await assert.rejects(f.execute(f.pending()[0]));
  const before = JSON.stringify([...f.tables._scheduled_functions.values()]);
  await assert.rejects(
    f.transaction('redrive', redrive.redrive, {
      projectId: f.projectId,
      submissionId: f.entries[0].state.id,
    }),
    error => {
      const data = error.data ?? error;
      return data.code === 'LEGACY_STORAGE_WRITES_PAUSED' && data.retryAt === now + OUTAGE_MS;
    },
  );
  assert.equal(JSON.stringify([...f.tables._scheduled_functions.values()]), before);
});
