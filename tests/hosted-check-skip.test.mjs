// SPDX-License-Identifier: Apache-2.0
// Checks that do not apply to a change skip cleanly and never hang the landing (Issue 9e71abcc).
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { hostedAcceptanceSchema } from '../dist/hosted-acceptance.js';
import { hostedCheckPlanSchema, testsNotAffected } from '../dist/hosted-check.js';

const env = {
  ...synthetic,
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-check-skip',
};
const prior = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, env));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const docsReason = 'Only Markdown documentation changed (including packaged docs)';
const skipped = { part: 'tests', status: 'not-affected', reason: docsReason };
const receipts = f => [...f.tables.projectHostedAcceptances.values()].map(r => JSON.parse(r.value));

test('the planner skips tests only when the standard check selects none for the changed paths', () => {
  assert.deepEqual(testsNotAffected({ scope: 'docs', reason: docsReason, tests: [] }, true), skipped);
  // A change that reaches tests, a full run and an opaque bring-your-own command never skip.
  assert.equal(
    testsNotAffected({ scope: 'scoped', reason: 'src scope', tests: ['tests/a.test.mjs'] }, true),
    undefined,
  );
  assert.equal(testsNotAffected({ scope: 'full', reason: 'full', tests: [] }, true), undefined);
  assert.equal(testsNotAffected({ scope: 'docs', reason: docsReason, tests: [] }, false), undefined);
  assert.equal(
    testsNotAffected({ scope: 'docs', reason: docsReason, tests: ['tests/a.test.mjs'] }, true),
    undefined,
  );
  assert.equal(
    testsNotAffected({ scope: 'docs', reason: 'x'.repeat(400), tests: [] }, true).reason.length,
    300,
  );
});

test('only a plan without test shards can record skipped tests', () => {
  const hash = 'a'.repeat(64);
  const plan = {
    head: hash,
    definition: hash,
    runtime: hash,
    environmentFingerprint: hash,
    lockfile: hash,
    selection: { sha256: hash, size: 1 },
    manifest: { sha256: hash, size: 1 },
  };
  assert(hostedCheckPlanSchema.safeParse({ ...plan, shardCount: 1, skipped }).success);
  assert(!hostedCheckPlanSchema.safeParse({ ...plan, shardCount: 3, skipped }).success);
  assert(
    !hostedCheckPlanSchema.safeParse({ ...plan, shardCount: 1, skipped: { ...skipped, status: 'pending' } })
      .success,
  );
});

async function landing(t, { path, plan }) {
  const f = await batchesFixture(t, {
    batchMaxSize: null,
    admissionCheck: 'full',
    count: 0,
    memberPaths: [path],
  });
  f.rawChecks.setPlanSelection(JSON.stringify({ scope: plan.skipped ? 'docs' : 'scoped', tests: [] }));
  f.rawChecks.setPlanOverrides(plan);
  await f.add(0);
  return f;
}
// Runs pending tasks without passing checks; returns the runs left queued.
async function settle(f) {
  for (let tick = 0; tick < 900; tick++) {
    const task = f.pending().find(t => !/MainAudit:start/.test(t.name));
    if (!task) return;
    await f.execute(task);
  }
  assert.fail('tasks did not settle');
}
async function drive(f) {
  for (let tick = 0; tick < 900 && states(f).some(s => s.phase !== 'landed'); tick++) {
    for (const run of f.runs().filter(run => run.status === 'queued' && run.gate?.mode !== 'audit'))
      await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    const task = f.pending().find(t => !/MainAudit:start/.test(t.name));
    if (!task) break;
    await f.execute(task);
  }
}

test('a landing outside the check scope lands on the static job alone and records skipped: not affected', async t => {
  const f = await landing(t, { path: 'docs/guide.md', plan: { shardCount: 1, skipped } });
  await drive(f);
  assert.deepEqual(
    states(f).map(s => s.phase),
    ['landed'],
  );
  const [receipt] = receipts(f);
  assert.deepEqual(receipt.check.skipped, skipped);
  assert(hostedAcceptanceSchema.safeParse(receipt).success);
  // One run, one job: no test shard was dispatched or waited on.
  const runs = f.runs().filter(run => run.gate?.mode !== 'audit');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].plan.shardCount, 1);
  assert.deepEqual(runs[0].plan.skipped, skipped);
});

test('a change inside the check scope still waits for every test shard and records no skip', async t => {
  const f = await landing(t, { path: 'src/a.ts', plan: { shardCount: 3 } });
  await settle(f);
  const queued = f.runs().filter(run => run.status === 'queued' && run.gate?.mode !== 'audit');
  assert.equal(queued.length, 1);
  // Shards still running: the landing waits on the check.
  const active = await f.rawChecks.activate(queued[0].id, 3);
  await settle(f);
  assert.notEqual(states(f)[0].phase, 'landed');
  assert.equal(receipts(f).length, 0);
  await f.rawChecks.pass(active);
  await drive(f);
  assert.deepEqual(
    states(f).map(s => s.phase),
    ['landed'],
  );
  const [receipt] = receipts(f);
  assert.equal(receipt.check.skipped, undefined);
  assert.equal(f.runs().find(run => run.id === active.id).plan.shardCount, 3);
});
