// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Keep the run (Item fa2c1383) cost guard: a mover lands under a running full admission check, in
// strict and fast, and every landing settles. Ceilings use the deterministic fixture measurements:
// calls and documents exact, read and write bytes inside the band of tests/keep-the-run-scenarios.mjs. Rows that retire are the
// comparison the wiring answers to; the unrelated rows are today's keep paths, the lifecycle a kept
// run will follow: its pass carries, or, with carry off, a fresh check follows. The red rows are a
// kept run that fails (today's keep path) against a retired one whose replacement fails. The C1 rows
// add an overlapping follower that arrives after the mover: the retire holds order for it today, the
// unrelated keep does not; the wired hold-order keep answers to the retire row. The fixture's runner
// reports a run in few calls and resolves no source; tests/keep-the-run-scenarios.mjs prices the
// real runner's ingest, source resolve and the prove action on top of these rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { synthetic, states } from './hosted-landing-batches-fixture.mjs';
import { fixture, drain, settle, pendingTasks } from './hosted-stale-check-fixture.mjs';
import { HOLD_ORDER, MEASURED, measuredProblems } from './keep-the-run-scenarios.mjs';
import { metricAliasProjectionCounts } from './observer-projection-budget.mjs';
import { storageClock } from './storage-clock.mjs';
import { captureWriteSites, reportWriteSites } from './landing-cost-write-sites.mjs';
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const strictRed = 'global-risk mover, strict, red';
const MOVERS = {
  'global-risk mover': 'package.json',
  'order-sensitive mover': 'convex/schema.ts',
  'unrelated mover': 'src/a.ts',
  'no checking row': 'src/a.ts',
};

async function measureScenario(t, name) {
  // A wall-clock composedAt can change whether a fake-time queue claim rearms the stall alarm.
  // The fixture's Date.now override also drives new Date() through this shared clock.
  storageClock(t, { elapsed: true });
  const [scenario, mode, ...flags] = name.split(', ');
  const has = flag => flags.includes(flag);
  const follower = has('C1 follower');
  const f = await fixture(t, {
    // The follower edits another line of the kept run's file: a clean overlap that composes behind it.
    memberPaths: [MOVERS[scenario], follower ? 'src/shared.ts' : 'src/b.ts', 'src/shared.ts'],
    memberContents: ['A\nb\nc\n', 'a\nb\nC\n', 'A\nb\nc\n'],
    landingMode: mode,
    concurrency: 1,
    conflict: false,
    count: 0,
  });
  if (has('carry off')) {
    const project = f.tables.hostedProjects.get(f.projectId);
    f.patch('hostedProjects', f.projectId, {
      autonomyPolicy: {
        ...project.autonomyPolicy,
        acceptance: { ...project.autonomyPolicy.acceptance, hostedCrossHeadReuse: false },
      },
    });
  }
  const idle = scenario === 'no checking row';
  await f.add(0);
  if (!idle) await f.add(1);
  await drain(f);
  const before = f.counts.length;
  const writeSites = captureWriteSites(f);
  const [a, b] = f.runs();
  const running = b ? await f.rawChecks.activate(b.id) : null;
  await f.rawChecks.pass(await f.rawChecks.activate(a.id));
  await drain(f);
  if (follower) {
    await f.add(2);
    await drain(f);
  }
  if (has('red'))
    for (const run of f.runs().filter(r => ['queued', 'running'].includes(r.status))) {
      if (run.id !== running?.id) {
        await f.fail(run.id);
        continue;
      }
      // The kept run is already running under its lease: it reports its own failure.
      const file = 'tests/member-1.test.mjs';
      await f.rawChecks.callback(f.rawChecks.shard(running, 0, 'failed'));
      await f.rawChecks.callback(
        f.rawChecks.complete(running, 'failed', {
          contractReports: {
            [file]: { failed: true, durationMs: 1, firstError: `${file}: synthetic failure` },
          },
        }),
      );
    }
  await drain(f);
  await settle(f);
  const finals = states(f).map(s => s.phase);
  if (has('red')) assert.deepEqual(finals.slice(0, 2), ['landed', 'terminal-failed'], JSON.stringify(finals));
  else
    assert(
      finals.every(phase => phase === 'landed'),
      JSON.stringify(finals),
    );
  assert.equal(pendingTasks(f).length, 0, 'settled work is idle');
  // The queue-sim invariant reads are the harness's own, not the product's.
  const costs = f.counts.slice(before).filter(cost => cost.name !== 'queueInvariantRead');
  const measured = {
    calls: costs.length,
    documents: costs.reduce((sum, cost) => sum + cost.documents, 0),
    readBytes: costs.reduce((sum, cost) => sum + cost.readBytes, 0),
    writeBytes: costs.reduce((sum, cost) => sum + cost.writeBytes, 0),
    writeSites,
    aliasWriteBytes: costs.reduce((sum, cost) => sum + metricAliasProjectionCounts(cost).writeBytes, 0),
    // f65d8024: each existing feed event writes a measured 33-byte commit field.
    // Include only that field in the exact-cost allowance. New events' other bytes still count.
    feedCommitBytes:
      33 *
      costs.reduce(
        (sum, cost) => sum + cost.written.filter(table => table === 'projectFeedEvents').length,
        0,
      ),
  };
  const byName = {};
  for (const cost of costs) byName[cost.name] = (byName[cost.name] ?? 0) + 1;
  const { writeSites: _sites, ...totals } = measured;
  t.diagnostic(
    JSON.stringify({
      name,
      ...totals,
      runs: f.runs().length,
      gates: f.runs().map(r => r.gate?.mode ?? 'none'),
      byName,
    }),
  );
  // The wired hold-order keep writes the kept run's landing row and one forked attempt (as
  // bindAdmissionProof does): both stay inside the bound the scenario table prices.
  if (!idle) {
    const row = [...f.tables.projectHostedLandingRequests.values()].find(
      r => r.submissionId === states(f)[1].id,
    );
    const attempts = [...f.tables.projectHostedLandingAttempts.values()].filter(
      a => a.submissionId === row.submissionId,
    );
    const bytes = value => Buffer.byteLength(JSON.stringify(value));
    const written = bytes(row) + Math.max(...attempts.map(bytes));
    t.diagnostic(JSON.stringify({ holdOrderWrite: written }));
    if (!(written <= HOLD_ORDER.writeBytes)) {
      reportWriteSites(t, `MEASURED.${name}`, measured.writeSites, true);
      assert.fail(`HOLD_ORDER.writeBytes (${name}): ${HOLD_ORDER.writeBytes} → ${written} B`);
    }
  }
  // Idle costs nothing: once settled, another drain makes no call at all.
  const settled = f.counts.length;
  await drain(f);
  assert.equal(f.counts.length, settled, 'a settled project makes no further calls');
  return measured;
}

for (const [name, baseline] of Object.entries(MEASURED))
  test(`fa2c1383 cost guard: ${name} under a running full check stays within today's measured cost`, async t => {
    const measured = await measureScenario(t, name);
    // Calls and documents are exact ceilings; bytes get the stated band (MEASURED_BYTE_BAND).
    const problems = measuredProblems(
      name,
      baseline,
      measured,
      measured.feedCommitBytes + measured.aliasWriteBytes,
    );
    reportWriteSites(t, `MEASURED.${name}`, measured.writeSites, problems.length > 0);
    assert.deepEqual(problems, [], problems.join('\n'));
  });

test('52e56db7 incident replay: two strict red runs measure identical database bytes', async t => {
  let first;
  await t.test('first run', async run => {
    first = await measureScenario(run, strictRed);
  });
  await t.test('second run', async run => {
    assert.deepEqual(await measureScenario(run, strictRed), first);
  });
});
