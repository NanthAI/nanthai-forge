// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item c3c69c57: a re-check after main moves names its real reason instead of the catch-all
// `not-eligible` (dogfood 2026-11-17: 139 main-race attempts, 1,667 min under that one code).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import {
  attemptCarryRefusal,
  fallbackKind,
  forkRaceReason,
  landingCarryRefusal,
} from '../dist/fallback-reasons.js';
import { batchesFixture, synthetic, states } from './hosted-landing-batches-fixture.mjs';
import { fixture, current, drain, settle } from './hosted-stale-check-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { isFinishWake, runFinishWake } from './hosted-finish-fixture.mjs';
const precompose = await import(moduleUrl('../convex/projectHostedLandingPrecompose.ts'));
function withSynthetic(t) {
  const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
  Object.assign(process.env, synthetic);
  t.after(() => {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}
const raceReasons = (f, submissionId) =>
  [...f.tables.projectHostedLandingAttempts.values()]
    .map(row => JSON.parse(row.value))
    .filter(attempt => attempt.submissionId === submissionId && attempt.recheckReason)
    .map(attempt => attempt.recheckReason);

const ready = { phase: 'ready', request: {} };
const checked = { check: { runId: 'run' }, candidate: { head: 'h' } };

test('main-race reason: a check main moved under and Forge retired is retired-running', () => {
  assert.equal(landingCarryRefusal({ phase: 'checking', request: {} }, {}), 'retired-running');
  // The stale-check and pipeline retirements requeue the landing for a fresh solo compose.
  assert.equal(
    landingCarryRefusal({ phase: 'queued', batchSolo: true, batchNeedsSoloCompose: true, request: {} }, {}),
    'retired-running',
  );
  // A passed entry held for its owner keeps its exact-tree carry: not refused here.
  assert.equal(
    landingCarryRefusal({ phase: 'ready', batchSolo: true, batchNeedsSoloCompose: true, request: {} }, {}),
    undefined,
  );
});

test('main-race reason: a member of a shared batch is cohort', () => {
  assert.equal(landingCarryRefusal({ ...ready, batchId: 'b' }, {}), 'cohort');
  assert.equal(landingCarryRefusal({ phase: 'checking', batchId: 'b', request: {} }, {}), 'cohort');
  // A solo fallback member still holding its batch id is not a batch member.
  assert.equal(landingCarryRefusal({ ...ready, batchId: 'b', batchSolo: true }, {}), undefined);
});

test('main-race reason: main moved before the landing had a check is no-check', () => {
  assert.equal(landingCarryRefusal({ phase: 'queued', request: {} }, {}), 'no-check');
  assert.equal(attemptCarryRefusal({ check: null, candidate: { head: 'h' } }), 'no-check');
  assert.equal(attemptCarryRefusal({ check: { runId: 'run' }, candidate: { head: null } }), 'no-check');
});

test('main-race reason: a composition with semantic merge members is semantic-plan', () => {
  assert.equal(attemptCarryRefusal({ ...checked, semanticPlan: { members: [{}] } }), 'semantic-plan');
  assert.equal(attemptCarryRefusal({ ...checked, semanticPlan: { members: [] } }), undefined);
});

test('main-race reason: culprit recovery and its restore-base fix Lane are recovery', () => {
  assert.equal(landingCarryRefusal(ready, { recoveryRunId: 'r' }), 'recovery');
  assert.equal(landingCarryRefusal(ready, { restoreBases: {} }), 'recovery');
  // Server recovery reverses are reverts too; recovery names the cause.
  assert.equal(
    landingCarryRefusal({ ...ready, request: { revertOf: 'x' } }, { recoveryRunId: 'r' }),
    'recovery',
  );
});

test('main-race reason: a user revert is revert', () => {
  assert.equal(landingCarryRefusal({ ...ready, request: { revertOf: 'x' } }, {}), 'revert');
  assert.equal(landingCarryRefusal(ready, {}), undefined);
});

test('main-race reasons: Forge-side causes are limitations, deliberate exact checks are genuine', () => {
  for (const code of ['retired-running', 'cohort', 'semantic-plan'])
    assert.equal(fallbackKind('main-race', code), 'limitation', code);
  for (const code of ['no-check', 'recovery', 'revert'])
    assert.equal(fallbackKind('main-race', code), 'genuine', code);
});

test('c3c69c57: a running admission retired by an overlapping acceptance records retired-running, not not-eligible', async t => {
  withSynthetic(t);
  const f = await fixture(t, { conflict: false });
  const [a, b] = f.runs();
  await f.rawChecks.activate(b.id);
  await f.rawChecks.pass(await f.rawChecks.activate(a.id));
  await drain(f, () => f.runs().find(r => r.id === b.id).status === 'cancelled');
  assert.equal(f.runs().find(r => r.id === b.id).status, 'cancelled');
  await settle(f);
  assert.equal(current(f, 1).phase, 'landed');
  assert.deepEqual(raceReasons(f, current(f, 1).id), ['retired-running']);
});

test('c3c69c57: a precomposed recompose after main moved records a named reason, not not-eligible', async t => {
  withSynthetic(t);
  const f = await batchesFixture(t, { count: 1, batching: false });
  const id = f.entries[0].state.id;
  const main = f.moveMain();
  await f.transaction(
    'main-race-precompose',
    { _handler: precompose.precomposeWaiting },
    { projectId: f.projectId, receiptIds: [main.receipt.id] },
  );
  // The precompose wake has no IO in flight, so it is the settle mutation (Item 9a04d916).
  await runFinishWake(
    f,
    f.pending().find(task => isFinishWake(task.name) && task.args[0].submissionId === id),
  );
  assert(JSON.parse(f.row(id).value).pending.precompose, 'the advisory precompose owns the recompose');
  for (let wave = 0; states(f)[0].phase !== 'landed'; wave++) {
    assert(wave < 20, JSON.stringify(states(f)));
    for (let tick = 0; ; tick++) {
      const task = f.pending().find(task => task.scheduledTime <= Date.now() + 30_000);
      if (!task) break;
      assert(tick < 500, 'finite event-driven work');
      await f.execute(task);
    }
    await f.passChecks();
  }
  // The entry had no check when main moved; its precomposed source was adopted by the claim.
  assert.deepEqual(raceReasons(f, id), ['no-check']);
});

// The reasons split only the code: every input refused before is refused now, and nothing else
// is. The old predicates are copied here from reuseDecision before Item c3c69c57.
const oldLandingRefused = (state, finish) =>
  state.phase !== 'ready' ||
  Boolean(state.batchId && !state.batchSolo) ||
  Boolean(finish.recoveryRunId) ||
  Boolean(finish.restoreBases) ||
  Boolean(state.request.revertOf);
const oldAttemptRefused = previous =>
  !previous.check || !previous.candidate.head || Boolean(previous.semanticPlan?.members.length);
test('c3c69c57: named refusals refuse exactly the inputs the catch-all refused', () => {
  let cases = 0;
  for (const phase of ['composing', 'queued', 'checking', 'ready', 'terminal-failed', 'landed'])
    for (const batchId of [undefined, 'b'])
      for (const batchSolo of [undefined, true])
        for (const batchNeedsSoloCompose of [undefined, true])
          for (const revertOf of [undefined, 'x'])
            for (const recoveryRunId of [undefined, 'r'])
              for (const restoreBases of [undefined, {}]) {
                const state = { phase, batchId, batchSolo, batchNeedsSoloCompose, request: { revertOf } };
                const finish = { recoveryRunId, restoreBases };
                const named = landingCarryRefusal(state, finish);
                assert.equal(named !== undefined, oldLandingRefused(state, finish), JSON.stringify(state));
                assert.notEqual(named, 'not-eligible');
                cases++;
              }
  for (const check of [null, { runId: 'run' }])
    for (const head of [null, 'h'])
      for (const semanticPlan of [undefined, { members: [] }, { members: [{}] }]) {
        const previous = { check, candidate: { head }, semanticPlan };
        const named = attemptCarryRefusal(previous);
        assert.equal(named !== undefined, oldAttemptRefused(previous), JSON.stringify(previous));
        cases++;
      }
  assert.equal(cases, 6 * 64 + 12);
});

// Re-check gap (lead read 2026-11-20): forks outside the finish install wrote child attempts on a
// moved main with no reason. Each insert site is either named here as same-main (with why) or names
// its race, so a new fork path cannot reopen the gap unnoticed.
test('c3c69c57 guard: every landing-attempt insert names a race onto a moved main or is same-main', () => {
  const sameMain = {
    'projectHostedLanding.ts': 'the first attempt has no parent',
    'projectHostedLandingStaleChecks.ts': 'the stale-check retire forks the current attempt on its own main',
    // Its proof requires the original's main to be current main, so only a stacked group of one differs.
    'projectHostedLandingAdmission.ts': 'binds the original to its admission proof on current main',
  };
  const dir = new URL('../convex/', import.meta.url);
  const inserting = readdirSync(dir)
    .filter(name => name.endsWith('.ts'))
    .filter(name => /\binsertLandingAttempt\(ctx,/.test(readFileSync(new URL(name, dir), 'utf8')));
  assert.deepEqual(
    Object.keys(sameMain).filter(name => !inserting.includes(name)),
    [],
    'a listed same-main site still inserts attempts',
  );
  for (const name of inserting) {
    if (sameMain[name]) continue;
    const source = readFileSync(new URL(name, dir), 'utf8');
    assert.ok(/forkRaceReason\(|attempt\.recheckReason = /.test(source), `${name} names its main race`);
  }
});

test('c3c69c57: a fork names its race only when it moves a checked parent onto another main', () => {
  const on = (head, check = { runId: 'run' }) => ({ main: { head }, check });
  // Metrics-only `forkReason`: the queue's `recheckReason` also unseals order (review 85fb41bc).
  assert.deepEqual(forkRaceReason(on('a'), on('b'), 'cohort'), { forkReason: 'cohort' });
  // A same-main fork is no race: one race counts once.
  assert.deepEqual(forkRaceReason(on('a'), on('a'), 'cohort'), {});
  // A deferred parent discarded no run: its cohort join stays byte-identical.
  assert.deepEqual(forkRaceReason(on('a', null), on('b'), 'cohort'), {});
});

// Review f86cb784: public stats reads compact metric slot 4 as "main race"; a fork's name must
// reach metrics without turning a failed cohort run into a merge-queue failure on stats.
test('c3c69c57: a fork name reaches metrics from the compact row but never stats slot 4', async () => {
  const projection = await import(moduleUrl('../convex/projectMetricReadProjection.ts'));
  const attempt = {
    at: '2026-11-20T00:00:00.000Z',
    parentAttemptId: 'parent',
    main: { head: 'h' },
    check: { runId: 'run' },
    forkReason: 'cohort',
    actor: { kind: 'agent' },
    candidate: { inputs: { sha256: 'i', size: 1 } },
  };
  const metric = projection.metricAttemptRow(attempt);
  assert.equal(metric[4], null, 'stats reads slot 4: a fork is not a main race there');
  const row = (value, extra = {}) => ({
    value: JSON.stringify({
      attemptId: 'a',
      submissionId: 's',
      value: JSON.stringify({ candidate: attempt.candidate, metric: value, ...extra }),
    }),
  });
  assert.equal(projection.readMetricAttempt(row(metric)).recheckReason, 'cohort');
  // A row without a fork name keeps its eight slots, so its bytes do not change.
  const plain = projection.metricAttemptRow({ ...attempt, forkReason: undefined });
  assert.equal(plain.length, 8);
  assert.equal(projection.readMetricAttempt(row(plain)).recheckReason, null);
});
