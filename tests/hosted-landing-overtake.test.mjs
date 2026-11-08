// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const { overtakeOlder, overtakeMark } = await import(moduleUrl('../src/landing-overtake.ts'));
const env = {
  ...synthetic,
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-overtake',
};
const prior = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, env));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const runOwner = (f, run) =>
  [...f.tables.projectHostedLandingAttempts.values()].find(
    row => JSON.parse(row.value).check?.runId === run.id,
  )?.submissionId;

test('overtakeOlder: once per entry, never a Ready or urgent one', () => {
  const target = { phase: 'checking', attemptId: 'a1', runId: 'r1', admitted: false };
  assert.equal(overtakeOlder(target), 'spend');
  assert.equal(
    overtakeOlder({ ...target, overtaken: overtakeMark(target) }),
    'free',
    'same stale generation',
  );
  assert.equal(
    overtakeOlder({ ...target, runId: 'r2', overtaken: overtakeMark(target) }),
    'hold',
    'its recheck',
  );
  assert.equal(
    overtakeOlder({ ...target, attemptId: 'a2', overtaken: overtakeMark(target) }),
    'hold',
    'a later attempt',
  );
  assert.equal(overtakeOlder({ ...target, phase: 'ready' }), 'hold', 'a passed entry about to land');
  assert.equal(overtakeOlder({ ...target, priority: 'urgent' }), 'hold');
  assert.equal(overtakeOlder({ ...target, phase: 'queued', runId: null }), 'free', 'no check of its own yet');
  assert.equal(
    overtakeOlder({ ...target, phase: 'queued', admitted: true }),
    'spend',
    'its Lane run goes stale',
  );
});

/** Core-claim incident 7d98c7da (dogfood, 2026-11-08, ~14 builders): passed landings
 * waited 17-40 min behind an older entry's recheck (receipts: order hold p90 21.9 min,
 * 29% of queue time), and when it landed most of them re-checked too. Replay with
 * pre-queue Lane checks and first-check proofs, as on the dogfood project: an older
 * change touching a global-risk file is re-checking in the queue (SLOW ticks) when N
 * newer, non-overlapping changes pass their Lane checks (FAST ticks). They must reach
 * main in about one FAST check plus bounded overhead, not after the older check (and a
 * recheck each). The older entry re-checks at most once more and that recheck holds
 * strict order. */
test('incident replay 7d98c7da: N parallel non-overlapping landings do not wait out an older check', async t => {
  const N = 8,
    LANE = 150,
    SLOW = 1000;
  // The first two add the same file with the same bytes: a clean composition, but not
  // path-disjoint, so whichever main moved under re-checks. The N newer touch other files.
  const memberPaths = [
    'src/shared.ts',
    'src/shared.ts',
    ...Array.from({ length: N }, (_, i) => `src/p${i}.ts`),
  ];
  const f = await batchesFixture(t, {
    batchMaxSize: null,
    admissionCheck: 'default',
    memberPaths,
    memberContents: ['shared', 'shared'],
    fileCount: 2,
    count: N + 2,
  });
  f.rawChecks.setPlanSelection(JSON.stringify({ scope: 'full', tests: [] }));
  const ids = f.entries.map(e => e.state.id);
  const pair = ids.slice(0, 2),
    fast = ids.slice(2);
  const rows = () => [...f.tables.projectHostedLandingRequests.values()];
  const owner = run =>
    rows().find(r => r.admission?.runId === run.id || r.runId === run.id)?.submissionId ?? runOwner(f, run);
  const due = new Map(),
    landedAt = new Map(),
    runsOf = new Map(ids.map(id => [id, new Set()]));
  let overtookRecheck = false;
  // Of the first two, one lands on its Lane run at once; the other (whichever main
  // moved under) re-checks in the queue for SLOW ticks. The N
  // newer changes pass their Lane checks meanwhile, after LANE ticks.
  const slowOf = () => pair.find(id => runsOf.get(id).size > 1);
  for (let tick = 0; states(f).some(s => s.phase !== 'landed' && s.phase !== 'terminal-failed'); tick++) {
    assert(tick < 20000, JSON.stringify(states(f).map(s => [s.sequence, s.phase])));
    for (const run of f.runs().filter(run => run.status === 'queued' && run.gate?.mode !== 'audit')) {
      const id = owner(run);
      runsOf.get(id)?.add(run.id);
      if (!due.has(run.id))
        due.set(run.id, tick + (fast.includes(id) ? LANE : runsOf.get(id).size > 1 ? SLOW : 0));
      if (due.get(run.id) <= tick) await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    }
    const task = f.pending().find(t => !/MainAudit:start|LandingStall/.test(t.name)) ?? null;
    if (!task) {
      if (f.runs().some(run => run.status === 'queued' && run.gate?.mode !== 'audit')) continue;
      break;
    }
    const before = new Set(
      states(f)
        .filter(s => s.phase === 'landed')
        .map(s => s.id),
    );
    await f.execute(task);
    for (const s of states(f))
      if (s.phase === 'landed' && !before.has(s.id)) {
        landedAt.set(s.id, tick);
        const slow = slowOf();
        if (slow && s.id !== slow && runsOf.get(slow).size > 2 && !landedAt.has(slow)) overtookRecheck = true;
      }
  }
  const slow = slowOf();
  assert(slow, 'one of the first two re-checked in the queue');
  const fastLanded = Math.max(...fast.map(id => landedAt.get(id) ?? Infinity));
  t.diagnostic(
    JSON.stringify({
      fastLandedByTick: fastLanded,
      slowLandedAt: landedAt.get(slow),
      slowRuns: runsOf.get(slow)?.size,
      fastRuns: fast.map(id => runsOf.get(id)?.size),
      firstCheck: f.reuseDecisions,
    }),
  );
  assert(
    states(f).every(s => s.phase === 'landed'),
    JSON.stringify(states(f).map(s => [s.sequence, s.phase])),
  );
  // Before the fix every newer landing waited for the older recheck (fastLanded > SLOW).
  assert(
    fastLanded < LANE + SLOW / 4,
    `newer landings reached main by tick ${fastLanded}, not after the older check`,
  );
  assert(fastLanded < landedAt.get(slow), 'the newer landings did not wait for the older one');
  for (const id of fast) assert.equal(runsOf.get(id)?.size, 1, 'each newer landing ran only its Lane check');
  // Lane check + queue recheck, + at most one more because newer landings overtook it
  // (none when its stale pass lands through the first-check proof).
  assert(
    runsOf.get(slow).size <= 3,
    `the older entry re-checks at most once more (${runsOf.get(slow).size} runs)`,
  );
  assert(!overtookRecheck, "the older entry's later recheck holds strict order");
});
