// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { moduleUrl } from './convex-module.mjs';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { diagnoseBatchFailure } from '../dist/hosted-batch-diagnosis.js';
import {
  semanticVerdict,
  semanticBudgetMessage,
  semanticPlanSchema,
  indexedSemanticPlan,
  semanticTests,
} from '../dist/intent-semantic-conflict.js';
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const pins = () => ({ candidateId: randomUUID(), head: 'a'.repeat(64), runId: randomUUID() });

test('all 28 batch pairs retain failures and every over-budget pair; disjoint test sets are skipped', () => {
  const ids = Array.from({ length: 8 }, () => randomUUID());
  const plan = {
    primaryIntentId: ids[0],
    members: ids.map((intentId, i) => ({
      intentId,
      outcome: `member ${i}`,
      version: 1,
      tests: [{ path: 'tests/shared.test.mjs', durationMs: 1 }],
    })),
  };
  plan.batchIntentIds = ids;
  assert.deepEqual(semanticPlanSchema.parse(indexedSemanticPlan(plan)), plan);
  const withoutLeader = { ...plan, members: plan.members.slice(1) };
  assert.deepEqual(semanticTests(withoutLeader), ['tests/shared.test.mjs']);
  const reports = { 'tests/shared.test.mjs': { durationMs: 1, failed: true } };
  const verdict = semanticVerdict(plan, reports, pins(), ids);
  assert.equal(verdict.conflicts.length, 28);
  assert.equal(semanticVerdict(plan, reports, pins()).conflicts.length, 28);
  assert.equal(
    new Set(
      verdict.conflicts.map(c =>
        c.intents
          .map(i => i.intentId)
          .sort()
          .join('+'),
      ),
    ).size,
    28,
  );
  const over = semanticVerdict(
    plan,
    { 'tests/shared.test.mjs': { durationMs: 90_000, failed: true } },
    pins(),
    ids,
  );
  assert.equal(over.overBudgetPairs.length, 28);
  assert.equal(over.conflicts.length, 0);
  for (const id of ids) assert(semanticBudgetMessage(over.overBudgetPairs).includes(id));
  plan.members[0].tests = [{ path: 'tests/leader.test.mjs', durationMs: 1 }];
  plan.members = plan.members.slice(0, 3);
  const filtered = semanticVerdict(
    plan,
    { ...reports, 'tests/leader.test.mjs': { durationMs: 1, failed: false } },
    pins(),
    ids,
  );
  assert.equal(filtered.conflicts.length, 1);
  assert.deepEqual(
    filtered.conflicts[0].intents.map(i => i.intentId),
    ids.slice(1, 3),
  );
});

test('path failures identify members without contracts and unrelated failures name no culprit', () => {
  const members = [0, 1].map(i => ({
    submissionId: randomUUID(),
    intentId: randomUUID(),
    outcome: `${i}`,
    paths: [`src/member-${i}.ts`],
    tests: [],
  }));
  const semantic = { conflicts: [], overBudgetPairs: [] };
  const run = {
    id: randomUUID(),
    contractReports: { 'tests/prove.test.mjs': { failed: true, firstError: 'at src/member-1.ts:12' } },
  };
  assert.deepEqual(diagnoseBatchFailure(members, run, semantic).suspects, [members[1].submissionId]);
  run.contractReports['tests/prove.test.mjs'].firstError = 'unrelated infrastructure';
  assert.deepEqual(diagnoseBatchFailure(members, run, semantic).suspects, []);
  members[0].paths = ['tests/prove.test.mjs'];
  assert.deepEqual(diagnoseBatchFailure(members, run, semantic).suspects, [members[0].submissionId]);
});

test('incident replay: B and C pass alone but fail together; both statuses name the pair without extra checks', async t => {
  // Measure the controller in a fresh process after compiling the fake Convex
  // modules above. Cold TypeScript compilation is test setup, not runtime work.
  if (process.env.FORGE_BATCH_CULPRIT_CHILD !== '1') {
    // The validating scheduler resolves this provider target lazily.
    moduleUrl('../convex/projectModalSource.ts');
    const child = spawn(
      process.execPath,
      [
        '--max-old-space-size=256',
        '--import',
        fileURLToPath(new URL('./check-runtime.mjs', import.meta.url)),
        '--test',
        '--test-concurrency=1',
        '--test-name-pattern=^incident replay:',
        fileURLToPath(import.meta.url),
      ],
      {
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          ...synthetic,
          FORGE_TEST_MODULE_DIRECTORY: dirname(fileURLToPath(moduleUrl('../convex/schema.ts'))),
          FORGE_TEST_PRECOMPILED: '1',
          FORGE_BATCH_CULPRIT_CHILD: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const output = [];
    child.stdout.on('data', bytes => output.push(bytes));
    child.stderr.on('data', bytes => output.push(bytes));
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    const result = Buffer.concat(output).toString();
    assert.equal(code, 0, result);
    t.diagnostic(result);
    return;
  }
  const shared = 'tests/b-c.test.mjs';
  const f = await batchesFixture(t, { count: 3, memberContracts: [[], [shared], [shared]] });
  // Exercise dogfood-sized unrelated metadata. Bodies must never be hydrated.
  const template = [...f.tables.projectHostedRecords.values()].find(row => row.kind === 'intent');
  for (let i = 0; i < 600; i++) {
    const key = randomUUID();
    const recordId = f.insert('projectHostedRecords', {
      ...template,
      _id: undefined,
      _creationTime: undefined,
      key,
    });
    f.insert('projectHostedRecordHeads', {
      projectId: f.projectId,
      kind: 'intent',
      key,
      version: 0,
      parent: 'owner',
      status: 'active',
      recordId,
    });
  }
  for (let i = 0; i < 575; i++)
    f.insert('projectHostedAcceptances', {
      projectId: f.projectId,
      receiptId: randomUUID(),
      submissionId: randomUUID(),
      attemptId: randomUUID(),
      sequence: i + 100,
      value: '{"unrelated":true}',
    });
  const passes = head => {
    const files = JSON.parse(f.c.objects.get(head)).files.map(file => file.path);
    return !(files.includes('member-1') && files.includes('member-2'));
  };
  assert(passes(f.entries[1].candidate.result.head), 'B passes on its original source');
  assert(passes(f.entries[2].candidate.result.head), 'C passes on its original source');
  const before = f.counts.length,
    started = performance.now();
  await f.drain();
  assert(!passes(f.runs()[0].request.expectedHead));
  await f.fail(f.runs()[0].id, shared);
  await f.drain();
  let snapshot = states(f);
  assert.equal(snapshot[0].batchDiagnostic.likelyCulprit, false);
  assert.equal(snapshot[0].batchDiagnostic.coverage, 'no-declared-contract');
  for (const i of [1, 2]) {
    assert(snapshot[i].batchDiagnostic.likelyCulprit);
    assert.equal(snapshot[i].batchDiagnostic.failsTogetherWith[0].submissionId, f.entries[3 - i].state.id);
    assert.equal(snapshot[i].batchDiagnostic.waitingFor, f.entries[0].state.id);
    assert.match(snapshot[i].batchDiagnostic.message, /Waiting for individual fallback/);
  }
  for (let i = 0; i < 3; i++) {
    const [run] = f.runs().filter(run => run.status === 'queued');
    assert(run);
    if (passes(run.request.expectedHead)) await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    else await f.fail(run.id, shared);
    await f.drain();
  }
  snapshot = states(f);
  assert.equal(snapshot[0].phase, 'landed');
  assert.equal(snapshot[1].phase, 'landed');
  assert.equal(snapshot[2].phase, 'terminal-failed');
  assert.match(snapshot[2].error.message, /fails together with/);
  assert(snapshot[1].batchDiagnostic.individualPassed);
  const settled = [...f.tables.projectHostedLandingAttempts.values()].find(
    row => row.attemptId === snapshot[1].attemptId,
  );
  assert(JSON.parse(settled.progress).batchDiagnostic.individualPassed);
  for (const i of [1, 2]) assert.match(snapshot[i].batchDiagnostic.message, /fails together with/);
  assert.equal(f.runs().length, 4, 'one shared and three existing fallback checks');
  assert.equal(f.pending().length, 0);
  const counts = f.counts.slice(before);
  const cost = {
    calls: counts.length,
    reads: counts.reduce((n, c) => n + c.documents, 0),
    writes: counts.reduce((n, c) => n + c.writes, 0),
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
    wallMs: performance.now() - started,
  };
  assert(cost.calls < 180 && cost.reads < 3200 && cost.writes < 1100, JSON.stringify(cost));
  assert(cost.peakRssBytes < 512 * 1024 * 1024, JSON.stringify(cost));
  t.diagnostic(
    JSON.stringify({
      members: 3,
      unrelatedIntents: 600,
      retainedReceipts: 575,
      fullChecks: f.runs().length,
      callsPerMember: cost.calls / 3,
      ...cost,
    }),
  );
});

test('a suspect submitted first is checked last while every queued member explains its wait', async t => {
  const failed = 'tests/culprit.test.mjs';
  const f = await batchesFixture(t, { count: 3, memberPaths: [failed, 'member-1', 'member-2'] });
  await f.drain();
  await f.fail(f.runs()[0].id, failed);
  await f.drain();
  const snapshot = states(f);
  assert(snapshot[0].batchDiagnostic.likelyCulprit);
  assert.equal(snapshot[0].batchDiagnostic.waitingFor, snapshot[1].id);
  const run = f.runs().find(run => run.status === 'queued');
  const files = JSON.parse(f.c.objects.get(run.request.expectedHead)).files.map(file => file.path);
  assert(files.includes('member-1'));
  assert(!files.includes(failed));
  for (let i = 0; i < 3; i++) {
    await f.passChecks();
    await f.drain();
  }
  assert(states(f).every(state => state.phase === 'landed'));
  assert.equal(f.runs().length, 4);
});

test('failed per-file evidence forces fallback even with disjoint contracts and an aggregate passed result', async t => {
  const a = 'tests/a.test.mjs',
    b = 'tests/b.test.mjs';
  const f = await batchesFixture(t, { count: 2, memberContracts: [[a], [b]] });
  await f.drain();
  const run = await f.rawChecks.activate(f.runs()[0].id);
  for (let i = 0; i < run.plan.shardCount; i++) await f.rawChecks.callback(f.rawChecks.shard(run, i));
  await f.rawChecks.callback(
    f.rawChecks.complete(run, 'passed', {
      contractReports: { [a]: { durationMs: 1, failed: false }, [b]: { durationMs: 1, failed: true } },
    }),
  );
  await f.drain();
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  assert.equal(states(f)[1].batchDiagnostic.likelyCulprit, true);
  assert.equal(states(f)[1].batchDiagnostic.failsTogetherWith.length, 0);
  for (let i = 0; i < 2; i++) {
    await f.passChecks();
    await f.drain();
  }
  assert.equal(f.runs().length, 3);
  assert(states(f).every(s => s.phase === 'landed'));
});

test('over-budget batch pairs are retained on both submissions without diagnostic checks', async t => {
  const path = 'tests/slow.test.mjs';
  const f = await batchesFixture(t, { count: 2, memberContracts: [[path], [path]] });
  await f.drain();
  const run = await f.rawChecks.activate(f.runs()[0].id);
  for (let i = 0; i < run.plan.shardCount; i++) await f.rawChecks.callback(f.rawChecks.shard(run, i));
  await f.rawChecks.callback(
    f.rawChecks.complete(run, 'passed', {
      contractReports: { [path]: { durationMs: 90000, failed: false } },
    }),
  );
  await f.drain();
  for (const state of states(f)) {
    assert.equal(state.batchDiagnostic.overBudgetPairs.length, 1);
    assert.equal(state.batchDiagnostic.overBudgetPairs[0].measuredMs, 90000);
    assert.match(state.batchDiagnostic.message, /pair attribution is unavailable/);
  }
  for (let i = 0; i < 2; i++) {
    await f.passChecks();
    await f.drain();
  }
  assert.equal(f.runs().length, 3);
});

test('three thousand changed paths stay on pinned Candidates; failed-path attribution survives bounded batch metadata', async t => {
  const paths = Array.from({ length: 3 }, (_, index) => `tests/member-${index}.test.mjs`);
  const f = await batchesFixture(t, { count: 3, memberPaths: paths, memberFileCount: 1000, fileCount: 2 });
  await f.drain();
  assert(
    f.entries.every(entry => entry.candidate.governance.paths.length === 1000),
    'real changed paths in each pinned Candidate',
  );
  const pinnedPathBytes = f.entries.reduce(
    (sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry.candidate.governance.paths)),
    0,
  );
  assert(pinnedPathBytes > 64 * 1024, 'fixture exceeds the batch metadata budget if paths are copied');
  const batchRow = () => [...f.tables.projectHostedLandingBatches.values()][0];
  assert(
    Buffer.byteLength(batchRow().value) < 64 * 1024,
    'batch metadata must not repeat large Candidate path lists',
  );
  await f.fail(f.runs()[0].id, paths[2]);
  await f.drain();
  assert(
    states(f)[2].batchDiagnostic.likelyCulprit,
    'full changed paths are read from the exact Candidate after failure',
  );
  assert(!states(f)[0].batchDiagnostic.likelyCulprit);
  assert(Buffer.byteLength(batchRow().value) < 64 * 1024, 'full paths are not copied back during diagnosis');
  for (let i = 0; i < 3; i++) {
    await f.passChecks();
    await f.drain();
  }
  assert(states(f).every(state => state.phase === 'landed'));
  assert.equal(f.runs().length, 4);
  assert.equal(f.pending().length, 0);
  t.diagnostic(
    JSON.stringify({
      changedPaths: 3000,
      pinnedPathBytes,
      batchBytes: Buffer.byteLength(batchRow().value),
      fullChecks: f.runs().length,
    }),
  );
});
