// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import { batchesFixture, states } from '../hosted-landing-batches-fixture.mjs';
import { inspectQueue, queueHistory, requestRows } from './invariants.mjs';

export function random(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
export const profiles = [
  'disjoint',
  'overlap',
  'hot-head',
  'slow-old',
  'batch-fail',
  'urgent',
  'faulty',
  'mixed',
];
const done = state => ['landed', 'terminal-failed'].includes(state.phase);
const owner = (f, run) =>
  [...f.tables.projectHostedLandingAttempts.values()].find(
    row => JSON.parse(row.value).check?.runId === run.id,
  )?.submissionId;

/** Events execute real fixture transactions. Only arrivals, provider results and
 * delivery order are supplied by the driver; it never sets queue decisions. */
export async function simulate(t, { seed, profile, count = 12, maxSteps = 4000, stopOn = null }) {
  const rng = random(seed),
    cluster = ['overlap', 'hot-head', 'slow-old', 'mixed'].includes(profile);
  const base = Array.from({ length: count }, (_, i) => `export const v${i} = 0;`).join('\n') + '\n';
  // `risk-mix` (Item 1018d0f8): every fourth change is order-sensitive (one schema change, CI actions).
  const paths = Array.from({ length: count }, (_, i) =>
    profile === 'risk-mix' && i % 4 === 1
      ? i === 1
        ? 'convex/schema.ts'
        : `.github/actions/a${i}/action.yml`
      : cluster && i < count / 2
        ? 'src/shared.ts'
        : `src/member-${i}.ts`,
  );
  const f = await batchesFixture(t, {
    count: 0,
    fileCount: 2,
    batching: profile === 'batch-fail' || profile === 'risk-mix',
    requestCheck: profile !== 'batch-fail' && profile !== 'risk-mix',
    // The dogfood settings: a full Lane check before the queue, fast landing mode.
    ...(profile === 'risk-mix' ? { admissionCheck: 'full', landingMode: 'fast', batchMaxSize: null } : {}),
    memberPaths: paths,
    baselineFiles: [['src/shared.ts', base]],
    memberContents: paths.map((path, i) =>
      path === 'src/shared.ts' ? base.replace(`v${i} = 0`, `v${i} = 1`) : `export const value = ${i};\n`,
    ),
  });
  f.rawChecks.setPlanSelection(JSON.stringify({ scope: 'full', tests: [] }));
  if (profile === 'risk-mix') {
    // CI and schema changes land without an owner review here: the profile is about queue order.
    const policy = f.tables.hostedProjects.get(f.projectId).autonomyPolicy;
    f.patch('hostedProjects', f.projectId, {
      autonomyPolicy: {
        ...policy,
        acceptance: { ...policy.acceptance, ownerApprovalPaths: ['scripts/deploy*'] },
      },
    });
  }
  const history = queueHistory(f),
    events = [],
    violations = new Map(),
    checks = new Map();
  const record = event => {
    events.push(event);
    if (events.length > 30) events.shift();
  };
  let arrived = 0,
    lost = false;
  const snapshot = async step => {
    const issues = [...history.check(), ...(await inspectQueue(f))];
    for (const issue of issues) violations.set(`${issue.id}:${issue.submission}:${issue.detail}`, issue);
    if (stopOn && issues.some(issue => issue.id === stopOn))
      return { seed, profile, step, violations: [...violations.values()], events, stopped: stopOn, f };
    return null;
  };
  for (let step = 0; step < maxSteps; step++) {
    try {
      const active = f
        .runs()
        .filter(run => ['queued', 'running'].includes(run.status) && run.gate?.mode !== 'audit');
      for (const run of active) {
        if (!checks.has(run.id)) {
          const id = owner(f, run),
            index = f.entries.findIndex(entry => entry.state.id === id);
          const slow = ['hot-head', 'slow-old'].includes(profile) && index === 0;
          // risk-mix: the schema change's checks are slow, so newer passes overtake it once and later
          // arrivals meet a holder whose overtake step is spent (the Item 1018d0f8 shape).
          const slowRisk = profile === 'risk-mix' && index === 1;
          checks.set(run.id, {
            due: Date.now() + (slow ? 180_000 : slowRisk ? 40_000 : 1000 + Math.floor(rng() * 4000)),
            index,
          });
        }
      }
      const due = active.filter(run => checks.get(run.id).due <= Date.now());
      const head = f.entries[0]?.state.id;
      const headRuns = new Set(
        [...f.tables.projectHostedLandingAttempts.values()]
          .filter(row => row.submissionId === head)
          .map(row => JSON.parse(row.value).check?.runId)
          .filter(Boolean),
      ).size;
      const arrivalAllowed =
        profile !== 'slow-old' ||
        arrived <= 1 ||
        states(f).some(state => state.id === head && done(state)) ||
        headRuns >= arrived;
      if (
        arrived < count &&
        arrivalAllowed &&
        (profile === 'slow-old' || rng() < 0.2 || (!active.length && !f.pending().length))
      ) {
        await f.add(
          arrived,
          profile === 'urgent' && arrived % 4 === 3 ? { request: { priority: 'urgent' } } : {},
        );
        record({ type: 'arrive', index: arrived++ });
      } else if (due.length && rng() < 0.75) {
        const run = due[Math.floor(rng() * due.length)],
          info = checks.get(run.id);
        const activated = run.status === 'queued' ? await f.rawChecks.activate(run.id) : run;
        const failed =
          profile === 'batch-fail' &&
          JSON.parse(f.c.objects.get(run.request.expectedHead)).files.some(file =>
            ['src/member-3.ts', 'src/member-8.ts'].includes(file.path),
          );
        if (failed) {
          await f.rawChecks.callback(f.rawChecks.shard(activated, 0, 'failed'));
          await f.rawChecks.callback(
            f.rawChecks.complete(activated, 'failed', {
              contractReports: {
                'tests/member.test.mjs': {
                  failed: true,
                  durationMs: 1,
                  firstError: 'TypeError at dist/member-3.js:1:1',
                },
              },
            }),
          );
        } else await f.rawChecks.pass(activated);
        record({ type: failed ? 'fail' : 'pass', index: info.index });
      } else {
        const nextCheck = Math.min(...active.map(run => checks.get(run.id).due));
        const pending = f.pending().filter(task => !/MainAudit:start/.test(task.name));
        const first = pending[0];
        // A provider completion happens before a later watchdog/deadline.
        if (nextCheck < (first?.scheduledTime ?? Infinity))
          f.advanceClock(Math.max(0, nextCheck - Date.now()));
        else if (first) {
          const window = pending.filter(task => task.scheduledTime <= first.scheduledTime + 5);
          const task = window[Math.floor(rng() * window.length)];
          if (profile === 'faulty' && !lost && task.name === 'projectHostedFinishDriver:drive') {
            f.patch('_scheduled_functions', task._id, { state: { kind: 'failed' } });
            lost = true;
            record({ type: 'lost', task: task.name });
          } else {
            await f.execute(task);
            record({ type: 'task', task: task.name });
          }
        } else if (arrived === count && states(f).every(done)) {
          // Drain the fixture's deferred-audit cancellations, then prove idle.
          for (const task of f.pending()) await f.execute(task);
          assert.equal(f.pending().length, 0, 'S10: idle owns no scheduled queue work');
          return { seed, profile, step, violations: [...violations.values()], events, f };
        } else assert.fail('L7: nonterminal queue has no enabled event');
      }
      const stopped = await snapshot(step);
      if (stopped) return stopped;
    } catch (error) {
      error.message += `\nReplay: FORGE_QUEUE_SIM_SEED=${seed} FORGE_QUEUE_SIM_PROFILE=${profile} node --import ./tests/check-runtime.mjs --test tests/hosted-landing-queue-sim.test.mjs\n${JSON.stringify(events)}`;
      throw error;
    }
  }
  assert.fail(`S11/L7: step cap reached; seed=${seed}, profile=${profile}; ${JSON.stringify(events)}`);
}
