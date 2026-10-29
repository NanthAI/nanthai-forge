import { execFileSync } from 'node:child_process';
import { fixture } from './semantic-conflict-fixture.mjs';
import { hostedLandingProgressSchema } from '../dist/hosted-landing.js';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { landingFixture } from './hosted-landing-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const review = await import(moduleUrl('../convex/projectIntentTestStore.ts'));
const oldKey = process.env.FORGE_HOSTED_CHECK_KEY_ID;
test.before(() => {
  process.env.FORGE_HOSTED_CHECK_KEY_ID = 'SYNTHETIC';
});
test.after(() => {
  if (oldKey === undefined) delete process.env.FORGE_HOSTED_CHECK_KEY_ID;
  else process.env.FORGE_HOSTED_CHECK_KEY_ID = oldKey;
});
for (const failed of [false, true])
  test(`hosted clean text Candidate retains ${failed ? 'a named conflict' : 'no conflict'} from its exact union reports`, async t => {
    const f = await fixture();
    const start = f.counts.length;
    const s = await f.enqueue(f.request);
    await f.drain();
    let run = await f.rawChecks.activate([...f.tables.projectHostedCheckRuns.values()][0].runId);
    assert.equal(run.semanticPlan.members.length, 2);
    for (let i = 0; i < run.plan.shardCount; i++)
      run = await f.rawChecks.callback(f.rawChecks.shard(run, i, failed ? 'failed' : 'passed'));
    const contractReports = Object.fromEntries(
      f.tests.map((file, i) => [file, { durationMs: 15, failed: failed && i === 1 }]),
    );
    run = await f.rawChecks.callback(
      f.rawChecks.complete(run, failed ? 'failed' : 'passed', { contractReports }),
    );
    await f.drain();
    const result = await f.status(s.id);
    if (!failed) {
      const measured = f.counts.slice(start);
      t.diagnostic(
        JSON.stringify({
          landingFunctionCalls: measured.length,
          documentsRead: measured.reduce((sum, count) => sum + count.documents, 0),
          documentsWritten: measured.reduce((sum, count) => sum + count.writes, 0),
          additionalFunctionCalls: 0,
        }),
      );
    }
    assert.equal(result.request.phase, failed ? 'terminal-failed' : 'ready');
    assert.equal(result.request.testFiles.counts.failed, failed ? 1 : 0);
    assert.equal(result.request.testFiles.counts.total, f.tests.length);
    if (failed) {
      assert.equal(result.request.observation.cause, 'conflict');
      assert.equal(result.request.error.code, 'INTENT_SEMANTIC_CONFLICT');
      const conflict = result.request.semanticConflicts[0];
      assert.equal(conflict.runId, run.id);
      assert.equal(conflict.candidateId, f.candidate.id);
      assert.deepEqual(new Set(conflict.intents.map(i => i.intentId)), new Set([f.primaryIntentId, f.peer]));
      const data = JSON.parse(
        await f.call('semanticReview', review.review, {
          projectId: f.projectId,
          intentId: f.primaryIntentId,
          candidateId: f.candidate.id,
          head: f.candidate.result.head,
        }),
      );
      assert.deepEqual(data.semanticConflicts, result.request.semanticConflicts);
      const attempt = [...f.tables.projectHostedLandingAttempts.values()].find(
        row => row.attemptId === result.request.attemptId,
      );
      assert.deepEqual(
        hostedLandingProgressSchema.parse(JSON.parse(attempt.progress)).semanticConflicts,
        result.request.semanticConflicts,
      );
    } else assert.equal(result.request.semanticConflicts, undefined);
    const count = f.tables.projectHostedCheckRuns.size;
    await f.enqueue(f.request);
    await f.drain();
    assert.equal(f.tables.projectHostedCheckRuns.size, count, 'replay never creates another check');
    assert.equal(f.pendingTasks().length, 0, 'terminal and ready queues are idle');
  });

test('contract-less hosted pair retains generic failure; unrelated failures do not become conflicts', async () => {
  const f = await landingFixture();
  const r = f.request({
    check: {
      kind: 'request',
      checkId: f.checkId,
      expectedDefinition: f.definition.digest,
      expectedConfiguration: f.configuration.digest,
      expectedEnvironment: f.runner.environmentFingerprint,
    },
  });
  const s = await f.enqueue(r);
  await f.drain();
  let run = await f.rawChecks.activate([...f.tables.projectHostedCheckRuns.values()][0].runId);
  await f.rawChecks.callback(f.rawChecks.complete(run, 'failed'));
  await f.drain();
  const result = (await f.status(s.id)).request;
  assert.equal(result.error.code, 'CHECK_FAILED');
  assert.equal(result.semanticConflicts, undefined);
});

test('actual composed union over 90 seconds returns the measured refusal', async () => {
  const f = await fixture(),
    s = await f.enqueue(f.request);
  await f.drain();
  let run = await f.rawChecks.activate([...f.tables.projectHostedCheckRuns.values()][0].runId);
  await f.rawChecks.callback(
    f.rawChecks.complete(run, 'failed', {
      contractReports: {
        [f.tests[0]]: { durationMs: 46_000, failed: false },
        [f.tests[1]]: { durationMs: 45_000, failed: true },
      },
    }),
  );
  await f.drain();
  const result = (await f.status(s.id)).request;
  assert.equal(result.error.code, 'CONTRACT_OVER_BUDGET');
  assert.match(result.error.message, /91000 ms/);
  assert.equal(result.semanticConflicts, undefined);
});

for (const size of [600, 1200])
  test(`${size} Intent declaration snapshots merge with bounded selected reads and no per-record function calls`, t => {
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const helper = new URL('./semantic-conflict-fixture.mjs', import.meta.url).href;
    const output = execFileSync(
      process.execPath,
      [
        '--expose-gc',
        '--input-type=module',
        '--eval',
        `import { measureSemanticScale } from ${JSON.stringify(helper)}; console.log(JSON.stringify(await measureSemanticScale(${size})));`,
      ],
      { encoding: 'utf8', env: environment },
    );
    t.diagnostic(output.trim());
  });

test('failed exact union reports remain a semantic conflict even when the aggregate says passed', async () => {
  const f = await fixture(),
    state = await f.enqueue(f.request);
  await f.drain();
  let run = await f.rawChecks.activate([...f.tables.projectHostedCheckRuns.values()][0].runId);
  for (let i = 0; i < run.plan.shardCount; i++) run = await f.rawChecks.callback(f.rawChecks.shard(run, i));
  await f.rawChecks.callback(
    f.rawChecks.complete(run, 'passed', {
      contractReports: Object.fromEntries(f.tests.map(path => [path, { durationMs: 1, failed: true }])),
    }),
  );
  await f.drain();
  const result = (await f.status(state.id)).request;
  assert.equal(result.error.code, 'INTENT_SEMANTIC_CONFLICT');
  assert.equal(result.observation.cause, 'conflict');
});
