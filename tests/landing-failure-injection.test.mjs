// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Issue d910db6b: every landing step, with a transient fault (fails once) and a
// permanent one (fails every time). A transient fault lands, once. A permanent
// one lands through another driver or ends every entry with a typed code whose
// next step is an exact command; never stranded, never accepted twice, nothing
// left scheduled. Pairs with models/landing-queue (supervisor-fixed: S3, L1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { api as acceptanceApi } from './hosted-acceptance-fixture.mjs';
import { INCIDENTS, LANDING_STEPS, PERMANENT, SCENARIOS, runLanding } from './landing-fault-matrix.mjs';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { CHECK_WALL_MS } from './queue-sim/invariants.mjs';
import { LANDING_STALL_MS } from '../dist/landing-stall.js';
import { HOSTED_FINISH_COMPOSE_WATCHDOG_MS } from '../dist/hosted-finish.js';
import { sourceWorkerPlan } from '../dist/convex-source-provider.js';
import { moduleUrl } from './convex-module.mjs';
import { normalizeHostedFinishResult } from '../dist/hosted-agent-finish-result.js';
import { networkContinuation } from '../dist/network-continuation.js';
import { hostedAgentCli } from '../dist/hosted-agent-cli.js';
import { operationWait } from '../dist/agent-operation-wait.js';
import { protocolMismatchError } from '../dist/hosted-agent-version.js';
import { waitFailure } from '../dist/wait-failure.js';
import { ForgeError } from '../dist/errors.js';
import { canonicalRoot } from '../dist/root-paths.js';

const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
/** Bounds in fake time: a lost step resumes within two stall windows; a permanent
 * fault ends within the supervisor's ladder (alarm, rounds, ending) per entry.
 * Split cohort halves run their ladders one after another. */
const TRANSIENT_MS = 2 * LANDING_STALL_MS + 5 * 60_000;
const permanentMs = entries => (4 * entries + 2) * LANDING_STALL_MS;
const { SOURCE_WAKE_SLACK_MS } = await import(moduleUrl('../convex/projectConvexSourceActive.ts'));
const SUPERVISOR = [
  'projectHostedLandingStall:',
  'projectHostedLandingStallAlert:',
  'projectHostedAcceptance:guard',
];
const root = '/synthetic/root';
/** Faults already injected by another suite; this guard fails if one disappears. */
const ELSEWHERE = [
  // wait, transient: an observe 502 during the initial or live read retries and returns the landing.
  ['./hosted-submission-wait.test.mjs', 'submission observe 502 during ${stage} read keeps waiting'],
  // check callback, permanent (CI never reports): the run lease ends the execution.
  [
    './hosted-mac-runner.test.mjs',
    'a hung heartbeat cannot keep execution alive beyond its last acknowledged lease',
  ],
  // check callback, transient (its completion wake lost): the supervisor replays it.
  ['./hosted-landing-supervisor.test.mjs', 'a lost check callback is replayed by the supervisor'],
];

/** The invariants every faulted run keeps. */
function assertOutcome(f, run, allowed, label) {
  const ended = states(f);
  for (const state of ended) {
    assert(
      state.phase === 'landed' || state.phase === 'terminal-failed',
      `${label}: stranded at ${state.phase}`,
    );
    if (state.phase === 'landed') continue;
    assert(allowed.includes(state.error?.code), `${label}: ended ${state.error?.code}, allowed ${allowed}`);
    // The requester's own result names the exact next command, never a dead end.
    const selection = { laneId: randomUUID(), operationId: state.operationId };
    const next = normalizeHostedFinishResult(root, selection, { submission: state });
    assert.equal(next.terminal, true, label);
    assert.match(next.command, /^nforge agent '\/synthetic\/root' land --save '\{.*"retry":true/, label);
    assert(!next.command.includes(state.operationId), `${label}: a retry is a new operation`);
  }
  const landed = ended.filter(s => s.phase === 'landed').length;
  assert.equal(f.tables.projectHostedAcceptances.size, landed, `${label}: each landing accepted once`);
  // Issue 13c63abe: a completion still pending after the run ended visibly.
  for (const plan of f.tables.projectHostedAcceptancePlans.values())
    if (plan.completion) {
      assert.equal(plan.completion.stalled?.code, 'ACCEPTANCE_COMPLETION_STALLED', `${label}: silent`);
      assert(plan.completion.stalled.message.includes("nforge x ROOT complete-merged '{}'"), label);
    }
  assert.equal(f.pending().length, 0, `${label}: idle 0, no timer left`);
  return landed;
}

/** Issue 13c63abe: after a lost completion tick, the replay applied it (the
 * landed Lanes completed, nothing retained), or, lost every time, the Lanes
 * stay as landed and the receipt read names the typed end. */
async function assertCompletion(f, expected) {
  for (const { lane } of f.entries)
    assert.equal((await f.readLane(lane.laneId)).state, expected, `Lane ${expected}`);
  for (const plan of f.tables.projectHostedAcceptancePlans.values()) {
    const receipt = JSON.parse(
      await f.transaction('acceptanceReceipt', acceptanceApi.receipt, {
        projectId: f.projectId,
        receiptId: plan.receiptId,
      }),
    );
    if (expected === 'completed') {
      assert.equal(plan.completion, undefined, 'the guard was cancelled with the completion');
      assert.equal(receipt.completion.appliedPage, receipt.completion.pages);
    } else assert.equal(receipt.completion.stalled.code, 'ACCEPTANCE_COMPLETION_STALLED');
  }
}

const matrix = new Map();
for (const [scenario, options] of Object.entries(SCENARIOS))
  test(`healthy ${scenario}: discovers its steps, no supervisor call, idle 0`, async t => {
    const f = await batchesFixture(t, options);
    const before = f.counts.length;
    const run = await runLanding(f);
    assertOutcome(f, run, [], scenario);
    assert(states(f).every(s => s.phase === 'landed'));
    const supervisor = [...run.keys.keys()].filter(key => SUPERVISOR.some(p => key.startsWith(p)));
    assert.deepEqual(supervisor, [], 'a healthy landing never runs the supervisor');
    for (const key of run.keys.keys()) {
      assert(
        key in PERMANENT,
        `new landing step ${key}: add it to PERMANENT with its permanent-fault outcome`,
      );
      if (!matrix.has(key)) matrix.set(key, { scenario, options, runs: f.runs().length });
    }
    t.diagnostic(JSON.stringify({ scenario, steps: run.keys.size, calls: f.counts.length - before }));
  });

test('the matrix covers every declared step and every landing step of the brief', () => {
  for (const key of Object.keys(PERMANENT)) assert(matrix.has(key), `${key} no longer runs: remove it`);
  const covered = new Set([...matrix.keys()].map(key => key.split('@')[1]));
  // Client calls with their own cases below, or in the named test elsewhere.
  for (const step of ['submit', 'check-callback', 'wait']) covered.add(step);
  assert.deepEqual(
    LANDING_STEPS.filter(step => !covered.has(step)),
    [],
  );
  for (const [file, name] of ELSEWHERE)
    assert(readFileSync(new URL(file, import.meta.url), 'utf8').includes(name), `${file}: ${name}`);
});

test('every landing incident keeps its replay and its TLA+ litmus pair', () => {
  const models = new URL('../models/landing-queue/', import.meta.url);
  const all = readFileSync(new URL('run.mjs', models), 'utf8');
  for (const {
    issue,
    replay: [file, name],
    model,
  } of INCIDENTS) {
    assert(readFileSync(new URL(file, import.meta.url), 'utf8').includes(name), `${issue}: ${file}: ${name}`);
    const found = readFileSync(new URL(`${model}.cfg`, models), 'utf8');
    assert.match(found, /\\\* Expect: /, `${model}.cfg reproduces the incident`);
    assert.doesNotMatch(readFileSync(new URL(`${model}-fixed.cfg`, models), 'utf8'), /\\\* Expect: /);
    for (const config of [model, `${model}-fixed`])
      assert(all.includes(`'${config}'`), `${config} runs in all`);
  }
});

test('step x fault matrix: transient faults land once, permanent faults end typed and bounded', async t => {
  assert(matrix.size >= Object.keys(PERMANENT).length);
  const rows = [];
  for (const [key, { scenario, options, runs }] of matrix)
    for (const fault of ['transient', 'permanent'])
      await t.test(`${key} ${fault} (${scenario})`, async t2 => {
        const f = await batchesFixture(t2, options);
        let hits = 0;
        const run = await runLanding(
          f,
          k => k === key && (fault === 'permanent' || hits === 0) && ++hits > 0,
        );
        assert(hits > 0, 'the fault was injected');
        const landed = assertOutcome(f, run, fault === 'transient' ? [] : PERMANENT[key], `${key} ${fault}`);
        if (key === 'projectHostedAcceptance:complete@receipt')
          await assertCompletion(f, fault === 'transient' ? 'completed' : 'active');
        if (fault === 'transient') {
          assert.equal(landed, states(f).length, 'a transient fault lands every entry');
          assert(run.elapsedMs <= TRANSIENT_MS, `resumed after ${run.elapsedMs / 60_000} min`);
        } else
          assert(run.elapsedMs <= permanentMs(states(f).length), `ended after ${run.elapsedMs / 60_000} min`);
        // A split or fallback cohort re-checks its members alone; no run beyond that.
        assert(f.runs().length <= runs + states(f).length, `${f.runs().length} check runs`);
        rows.push({ key, fault, hits, landed, minutes: Math.round(run.elapsedMs / 60_000) });
      });
  t.diagnostic(JSON.stringify(rows));
});

// Review ba9ce962 L2 (Item 9a04d916): a double loss on the compose path. The action doing a
// step's IO is lost (a deploy mid-action), then the next finish drive of the same entry is lost
// too. The step's retained retry is a mutation that only hands IO to a drive, so every
// scenario with that hop resumes within one check wall and the stall supervisor never runs.
// Before L2 the retry was itself a drive: losing it left the entry to the 15-minute alarm.
test('double loss: a lost IO drive and its lost retry resume without the stall supervisor', async t => {
  let covered = 0;
  for (const [scenario, options] of Object.entries(SCENARIOS)) {
    const f = await batchesFixture(t, options);
    let entry = null,
      hits = 0;
    const run = await runLanding(f, key => {
      if (hits >= 2 || key !== 'projectHostedFinishDriver:drive@compose') return false;
      const args = f.pending()[0].args[0];
      if (hits === 0 ? !args.command : args.submissionId !== entry) return false;
      entry = args.submissionId;
      return ++hits > 0;
    });
    assertOutcome(f, run, [], `${scenario} double loss`);
    if (!hits) continue;
    covered++;
    assert.equal(hits, 2, `${scenario}: both losses were injected`);
    const supervisor = [...run.keys.keys()].filter(key => SUPERVISOR.some(p => key.startsWith(p)));
    assert.deepEqual(supervisor, [], `${scenario}: a mutation owned the entry, not the 15-minute alarm`);
    assert(run.elapsedMs < CHECK_WALL_MS, `${scenario}: resumed after ${run.elapsedMs / 1000} s`);
    assert(
      states(f).every(s => s.phase === 'landed'),
      scenario,
    );
  }
  assert(covered > 0, 'at least one scenario hands IO out of a mutation');
  t.diagnostic(JSON.stringify({ covered }));
});

// Review d4f55e9f F1 (Item 9a04d916): the compose job's source action is lost (a deploy
// mid-action), then the 120 s compose watchdog that owns it. The watchdog was a drive
// action, so losing it too left the entry to the 15-minute alarm. It is the `retry`
// mutation, which Convex runs exactly once: the entry resumes within one check wall and
// the supervisor never runs. Since e62d834b a lost step action is owned first by the step's
// own repair wake, also a mutation, so no watchdog is lost in that case; a lost dispatch is
// still owned by the compose watchdog.
test('incident 9a04d916 F1: a lost source action resumes through a mutation (its repair wake or the 120 s watchdog), without the stall supervisor', async t => {
  let covered = 0;
  for (const [scenario, options] of Object.entries(SCENARIOS))
    for (const source of ['projectConvexSource:step@compose', 'projectConvexSource:dispatch@compose']) {
      const f = await batchesFixture(t, options);
      let lostAt = null,
        lostJob = null,
        watchdog = null,
        repaired = null;
      const run = await runLanding(f, key => {
        if (lostAt === null) {
          if (key !== source) return false;
          lostAt = Date.now();
          lostJob = f.pending()[0].args[0]?.jobId ?? null;
          return true;
        }
        // e62d834b: a lost step action is first owned by the step's own repair wake (a mutation, due at the
        // worker lease end), before the 120 s compose watchdog; the finish wakes after it are its progress.
        if (!watchdog && !repaired && key.startsWith('projectConvexSourceLease:expired')) {
          repaired = {
            key,
            jobId: f.pending()[0].args[0]?.jobId,
            afterMs: f.pending()[0].scheduledTime - lostAt,
          };
          return false;
        }
        if (repaired) return false;
        // The finish wake due after the loss is the watchdog. An action can be lost; a
        // mutation is not (Convex retries its internal errors).
        if (watchdog || !key.startsWith('projectHostedFinishDriver:') || !key.endsWith('@compose'))
          return false;
        if (f.pending()[0].scheduledTime <= lostAt) return false;
        watchdog = key;
        return key.startsWith('projectHostedFinishDriver:drive@');
      });
      const label = `${scenario}, ${source} then its watchdog`;
      assertOutcome(f, run, [], label);
      if (lostAt === null) continue;
      covered++;
      assert(watchdog || repaired, `${label}: a watchdog owned the lost source action`);
      const supervisor = [...run.keys.keys()].filter(key => SUPERVISOR.some(p => key.startsWith(p)));
      assert.deepEqual(supervisor, [], `${label}: a mutation owned the entry, not the 15-minute alarm`);
      assert(run.elapsedMs < CHECK_WALL_MS, `${label}: resumed after ${run.elapsedMs / 1000} s`);
      if (repaired) {
        assert(lostJob, `${label}: the lost action names its source job`);
        assert.equal(repaired.jobId, lostJob, `${label}: the repair wake is the lost step's own`);
        const due = sourceWorkerPlan({}).workerLeaseMs + SOURCE_WAKE_SLACK_MS;
        assert(due < HOSTED_FINISH_COMPOSE_WATCHDOG_MS, 'the wake is due before the compose watchdog');
        assert(
          repaired.afterMs <= due,
          `${label}: the step's repair wake owned the lost action at its lease end (${repaired.afterMs} ms)`,
        );
      } else
        assert.equal(
          watchdog,
          'projectHostedFinishDriver:retry@compose',
          `${label}: the watchdog is a mutation`,
        );
      assert(
        states(f).every(s => s.phase === 'landed'),
        label,
      );
    }
  assert(covered > 0, 'at least one scenario loses a source action');
  t.diagnostic(JSON.stringify({ covered }));
});

// Review d4f55e9f F3: the claim retry. Another finish holds the Channel's lease for a
// second while this step claims; the step re-tries the claim 250 ms later. On main that
// retry was a drive action, so losing it left the entry to the 15-minute alarm. It is the
// settle mutation (Item 9a04d916).
test('single loss: a lost claim retry wake is a mutation, never the alarm', async t => {
  const f = await batchesFixture(t, SCENARIOS['serial agent finish']);
  let wake = null;
  const run = await runLanding(f, key => {
    if (wake || !key.startsWith('projectHostedFinishDriver:')) return false;
    const task = f.pending()[0];
    const queue = [...f.tables.projectHostedLandingQueues.values()][0];
    const finish = [...f.tables.projectHostedFinishes.values()].find(
      r => r.submissionId === task.args[0].submissionId,
    );
    // The claim retry: the step met the held Channel (no compose pending) and re-tries in 250 ms.
    if (
      task.scheduledTime - Date.now() === 250 &&
      queue.lease?.owner === 'another-finish' &&
      !JSON.parse(finish.value).pending
    ) {
      wake = key.split('@')[0];
      return wake === 'projectHostedFinishDriver:drive';
    }
    if (key.endsWith('@publish')) {
      f.patch('projectHostedLandingQueues', queue._id, {
        lease: {
          owner: 'another-finish',
          token: (queue.lease?.token ?? 0) + 1,
          until: Date.now() + 1000,
          submissionId: 'another-submission',
          attemptId: 'another-attempt',
        },
      });
    }
    return false;
  });
  assertOutcome(f, run, [], 'claim retry');
  assert(wake, 'the step met a held Channel and re-tried its claim');
  const supervisor = [...run.keys.keys()].filter(key => SUPERVISOR.some(p => key.startsWith(p)));
  assert.deepEqual(supervisor, [], 'a mutation owned the claim retry, not the 15-minute alarm');
  assert(run.elapsedMs < CHECK_WALL_MS, `resumed after ${run.elapsedMs / 1000} s`);
  assert.equal(wake, 'projectHostedFinishDriver:settle');
  assert(states(f).every(s => s.phase === 'landed'));
});

// Lead decision on 9a04d916 (option b, review d4f55e9f F3): the hops whose step does IO on a
// healthy landing. Each `pick`ed hop is a finish wake with a new wake id at `step`, the n-th
// of its entry. One run per hop loses the first drive action serving it: the drive its
// settle mutation hands the IO to. A lost hop drive used to wait for the 15-minute alarm.
// The hop is the settle mutation, which Convex runs exactly once, and its retry backstops
// the drive.
async function hopLost(t, step, pick) {
  let covered = 0;
  for (const [scenario, options] of Object.entries(SCENARIOS))
    for (let j = 0; ; j++) {
      const f = await batchesFixture(t, options);
      const seen = new Set(),
        per = new Map();
      let target = null,
        hops = 0,
        lost = null;
      const run = await runLanding(f, key => {
        if (!key.startsWith('projectHostedFinishDriver:')) return false;
        const { submissionId, wakeId } = f.pending()[0].args[0];
        if (target === null && key.endsWith(`@${step}`) && !seen.has(wakeId)) {
          seen.add(wakeId);
          const n = per.get(submissionId) ?? 0;
          per.set(submissionId, n + 1);
          if (pick(n) && hops++ === j) target = wakeId;
        }
        if (lost || wakeId !== target || !key.startsWith('projectHostedFinishDriver:drive@')) return false;
        lost = key;
        return true;
      });
      const label = `${scenario}, ${step} hop ${j} (${lost ?? 'nothing'} lost)`;
      assertOutcome(f, run, [], label);
      if (target === null) break;
      assert(j < 12, `${label}: bounded hops`);
      if (!lost) continue; // a hop with no IO is the settle mutation alone: nothing to lose
      covered++;
      const supervisor = [...run.keys.keys()].filter(key => SUPERVISOR.some(p => key.startsWith(p)));
      assert.deepEqual(supervisor, [], `${label}: a mutation owned the hop, not the 15-minute alarm`);
      assert(run.elapsedMs < CHECK_WALL_MS, `${label}: resumed after ${run.elapsedMs / 1000} s`);
      assert(
        states(f).every(s => s.phase === 'landed'),
        label,
      );
    }
  assert(covered > 0, `a ${step} hop drives IO`);
  t.diagnostic(JSON.stringify({ step, covered }));
}
test('single loss: a lost first acceptance step is a mutation, never the alarm', t =>
  hopLost(t, 'publish', n => n === 0));
test('single loss: a lost next acceptance page is a mutation, never the alarm', t =>
  hopLost(t, 'publish', n => n === 1));
// Every compose hop of every entry, the cohort's first compose step among them.
test('single loss: a lost cohort first compose step is a mutation, never the alarm', t =>
  hopLost(t, 'compose', () => true));

test('receipt completion: a lost cohort tick replays its own arguments; failing again alerts the owner once', async t => {
  // Issue 13c63abe. Transient: the first tick of a cohort carries the precompose
  // trigger; its replay keeps it and completes both Lanes, one guard call each lost tick.
  const f = await batchesFixture(t, SCENARIOS['batched cohort']);
  const lost = [];
  const run = await runLanding(
    f,
    key => key === 'projectHostedAcceptance:complete@receipt' && !lost.length && lost.push(key) > 0,
  );
  assertOutcome(f, run, [], 'cohort completion replay');
  await assertCompletion(f, 'completed');
  assert.equal(run.keys.get('projectHostedAcceptance:guard@receipt'), 1, 'one guard call for one lost tick');
  const replays = f.tables._scheduled_functions;
  const precomposed = [...replays.values()].filter(
    task => task.name === 'projectHostedAcceptance:complete' && task.args[0].precompose,
  );
  assert.equal(precomposed.length, 2, 'the replay keeps the precompose trigger');
  // Permanent, alerts on: the owner hears once, with the next command; nothing stays scheduled.
  const g = await batchesFixture(t, SCENARIOS['serial agent finish']);
  const policy = g.tables.hostedProjects.get(g.projectId).autonomyPolicy;
  g.patch('hostedProjects', g.projectId, {
    autonomyPolicy: { ...policy, agentDefaults: { ...policy.agentDefaults, stallAlerts: { enabled: true } } },
  });
  const ended = await runLanding(g, key => key === 'projectHostedAcceptance:complete@receipt');
  assertOutcome(g, ended, [], 'completion stalled');
  await assertCompletion(g, 'active');
  const alerts = g.metrics.stallDeliveries.filter(d =>
    d.subject.startsWith('[Forge] Landing completion stalled'),
  );
  assert.equal(alerts.length, 1, 'one owner alert');
  assert.match(alerts[0].text, /nforge x ROOT complete-merged/);
  assert.equal(ended.keys.get('projectHostedAcceptance:guard@receipt'), 2, 'one replay, then the end');
});

test('submit: a lost reply retried with the same operationId reconciles to one landing', async t => {
  // Wave 3c: a land submit was lost while the CLI contract was skewed and the
  // builder retried it with the same operationId.
  const f = await batchesFixture(t, SCENARIOS['serial agent finish']);
  const [entry] = f.entries;
  const replay = await f.enqueue(entry.request);
  assert.equal(replay.id, entry.state.id, 'the same submission, not a second one');
  assert.equal(f.tables.projectHostedLandingRequests.size, 1);
  await runLanding(f);
  assertOutcome(f, null, [], 'submit replay');
  assert.equal(states(f)[0].phase, 'landed');
});

test('submit: an unknown outcome names the exact replay of the same operation', () => {
  const operationId = randomUUID();
  const pending = networkContinuation(
    root,
    { url: 'https://fixture.invalid', projectId: 'project' },
    'finish',
    { laneId: randomUUID() },
    operationId,
    { code: 'EXCHANGE_REQUEST_FAILED', message: 'fetch failed' },
  );
  assert.equal(pending.result.inProgress, true);
  assert.equal(pending.result.next.operationId, operationId, 'replay, never a new attempt');
  assert.match(pending.result.command, new RegExp(`land --save '.*"operationId":"${operationId}"`));
});

test('check callback: a re-delivered result (lost reply) is reconciled; the landing lands once', async t => {
  const f = await batchesFixture(t, SCENARIOS['serial agent finish']);
  let delivered = 0;
  for (let tick = 0; tick < 200; tick++) {
    for (const run of f.runs().filter(r => r.status === 'queued')) {
      const active = await f.rawChecks.activate(run.id);
      for (let i = 0; i < active.plan.shardCount; i++)
        await f.rawChecks.callback(f.rawChecks.shard(active, i));
      const complete = f.rawChecks.complete(active);
      await f.rawChecks.callback(complete);
      // The CI reporter lost the reply and sends the same bytes again.
      await f.rawChecks.callback(complete);
      delivered++;
    }
    const task = f.pending()[0];
    if (!task) break;
    await f.execute(task);
  }
  assert.equal(delivered, 1);
  assertOutcome(f, null, [], 'callback replay');
  assert.equal(states(f)[0].phase, 'landed');
  assert.equal(f.runs().length, 1, 'no second check');
});

test('check callback: a slow live check arms no supervisor round (no added calls)', async t => {
  const f = await batchesFixture(t, SCENARIOS['serial agent finish']);
  const ran = [];
  for (let tick = 0; tick < 50 && f.pending().length; tick++) {
    for (const run of f.runs().filter(r => r.status === 'queued')) await f.rawChecks.activate(run.id);
    const task = f.pending()[0];
    ran.push(task.name);
    await f.execute(task);
  }
  assert.equal(states(f)[0].phase, 'checking', 'CI is still running');
  assert(ran.includes('projectHostedLandingStall:alarm'), 'the stall alarm fired');
  assert(
    !ran.includes('projectHostedLandingStall:deadline'),
    'the alarm replayed nothing, so the run lease alone owns the check',
  );
});

test('wait: a permanent read failure (CLI/server contract skew) names the same wait', async t => {
  // Wave 3c (Issue 3205f7e6): every wait failed with HOSTED_PROTOCOL_INVALID for
  // about 9 minutes while landings kept running.
  const s = agentFixture(t),
    transport = s.transport();
  const operationId = randomUUID();
  transport.query = async () => {
    throw protocolMismatchError();
  };
  const command = { operationIds: [operationId], until: 'acceptance', timeoutSeconds: 1 };
  await assert.rejects(hostedAgentCli(s.root, 'wait', command, s.address, transport), error => {
    assert.equal(error.code, 'HOSTED_PROTOCOL_INVALID');
    const expected = operationWait(canonicalRoot(s.root), { ...command, ...s.address });
    assert.equal(error.recovery.command, expected.waitCommand);
    assert.match(
      error.message,
      /unaffected by this failed read; once the cause is fixed, resume with: nforge/,
    );
    return true;
  });
});

test('wait: refused selections keep their own message; a recovery is never replaced', () => {
  const resume = { next: { action: 'wait' }, waitCommand: 'nforge agent ROOT wait {}' };
  for (const code of ['BAD_ARGUMENT', 'NOT_FOUND']) {
    const error = new ForgeError(code, 'Select one hosted landing operation.');
    assert.equal(waitFailure(error, resume), error);
  }
  const own = new ForgeError('COMPOSITION_CONFLICT', 'x', undefined, { command: 'sync' });
  assert.equal(waitFailure(own, resume), own);
  const plain = new Error('not a Forge error');
  assert.equal(waitFailure(plain, resume), plain);
});
