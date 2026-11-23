// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import { storageClock } from './storage-clock.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { saveBytes } from '../dist/hosted-save.js';
import { acceptanceFixture } from './hosted-acceptance-fixture.mjs';
import { checksFixture } from './hosted-checks-fixture.mjs';
import { composeFixture, api as composeApi, jobApi as composeJobs } from './hosted-compose-fixture.mjs';
import { code } from './hosted-landing-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const { MEMBER_WORK_BUDGET } = await import(moduleUrl('../convex/abuseLimits.ts'));
const savedKey = process.env.FORGE_HOSTED_CHECK_KEY_ID;
test.before(() => {
  process.env.FORGE_HOSTED_CHECK_KEY_ID = 'SYNTHETIC';
});
test.after(() => {
  if (savedKey === undefined) delete process.env.FORGE_HOSTED_CHECK_KEY_ID;
  else process.env.FORGE_HOSTED_CHECK_KEY_ID = savedKey;
});
async function ready(f, checkId, definition, agent = true) {
  const item = await f.makeCandidate([], [], {
    governance: { version: 1, paths: ['src/leaf.ts'], ownerInputs: false },
  });
  const run = await f.rawChecks.enqueue(
    f.rawChecks.selection({
      candidateId: item.candidate.id,
      expectedHead: item.candidate.result.head,
      checkId,
      expectedDefinition: definition.digest,
    }),
  );
  await f.rawChecks.pass(await f.rawChecks.activate(run.id));
  return (await f.ready(item, { agent, check: { kind: 'run', runId: run.id } })).state;
}
for (const legacy of [false, true])
  test(`publication uses the server verify definition, including legacy project metadata (${legacy})`, async () => {
    const f = await acceptanceFixture();
    const secondId = f.rawChecks.checkId;
    const second = await f.rawChecks.configure(
      {
        kind: 'definition',
        checkId: secondId,
        command: { name: 'lint', executable: 'node', args: ['tools/lint.mjs'], environmentLabel: 'clean' },
      },
      f.rawChecks.definition.digest,
    );
    const state = await ready(f, secondId, second);
    await f.rawChecks.configure({
      kind: 'definition',
      checkId: randomUUID(),
      command: { name: 'verify', executable: 'node', args: ['tools/verify.mjs'], environmentLabel: 'clean' },
    });
    if (legacy) f.patch('hostedProjects', f.projectId, { landingCheckId: undefined });
    await assert.rejects(f.accept(state), code('CHECK_NOT_PASSED'));
    assert.equal(f.currentMain().sourceRevision, 0);
    const g = await acceptanceFixture();
    await g.rawChecks.configure({
      kind: 'definition',
      checkId: randomUUID(),
      command: { name: 'lint', executable: 'node', args: ['tools/lint.mjs'], environmentLabel: 'clean' },
    });
    assert.equal(
      (await g.accept(await ready(g, g.rawChecks.checkId, g.rawChecks.definition))).status,
      'landed',
    );
  });
test('owner person can review another defined check and sole definitions keep their names', async () => {
  for (const sole of [false, true]) {
    const f = await acceptanceFixture();
    const id = sole ? f.rawChecks.checkId : randomUUID();
    const definition = await f.rawChecks.configure(
      {
        kind: 'definition',
        checkId: id,
        command: { name: 'test', executable: 'node', args: ['tools/test.mjs'], environmentLabel: 'clean' },
      },
      sole ? f.rawChecks.definition.digest : null,
    );
    assert.equal((await f.accept(await ready(f, id, definition, sole))).status, 'landed');
  }
});
const member = f => f.insert('projectContributors', { projectId: f.projectId, contributor: 'member' });
const full = () => ({
  day: Date.now() - (Date.now() % MEMBER_WORK_BUDGET.windowMs),
  checks: MEMBER_WORK_BUDGET.checks,
  composes: MEMBER_WORK_BUDGET.composes,
  submissions: MEMBER_WORK_BUDGET.submissions,
});
test('fresh member checks consume a fixed counter once and full counters refuse before provider work', async t => {
  storageClock(t);
  const f = await checksFixture();
  const id = member(f),
    request = f.selection();
  const first = await f.enqueue(request, 'member');
  assert.equal(f.tables.projectContributors.get(id).workBudget?.checks, 1);
  assert.equal((await f.enqueue(request, 'member')).id, first.id);
  assert.equal(f.tables.projectContributors.get(id).workBudget.checks, 1);
  f.patch('projectContributors', id, { workBudget: full() });
  const runs = f.tables.projectHostedCheckRuns.size,
    operations = f.tables.projectHostedOperations.size;
  await assert.rejects(f.enqueue(f.selection(), 'member'), code('RATE_LIMITED'));
  assert.equal(f.tables.projectHostedCheckRuns.size, runs);
  assert.equal(f.tables.projectHostedOperations.size, operations);
  assert.equal(
    (await f.enqueue(request, 'member')).id,
    first.id,
    'an original replay still reconciles at the cap',
  );
});
test('fresh member composes consume once, reject atomically at the cap and reset at a UTC day boundary', async t => {
  storageClock(t);
  const f = await composeFixture();
  const id = member(f),
    selection = f.selection([await f.lane(f.baseline)]);
  const prepare = () =>
    f.call(
      'composePrepare',
      composeApi.prepare,
      { projectId: f.projectId, request: JSON.stringify(selection.request) },
      'member',
    );
  await prepare();
  assert.equal(f.tables.projectContributors.get(id).workBudget?.composes, 1);
  await prepare();
  assert.equal(f.tables.projectContributors.get(id).workBudget.composes, 1);
  f.patch('projectContributors', id, { workBudget: full() });
  selection.request.operationId = randomUUID();
  const count = f.tables.projectHostedComposes.size;
  await assert.rejects(prepare(), code('RATE_LIMITED'));
  assert.equal(f.tables.projectHostedComposes.size, count);
  f.patch('projectContributors', id, {
    workBudget: { ...full(), day: full().day - MEMBER_WORK_BUDGET.windowMs },
  });
  await prepare();
  assert.equal(f.tables.projectContributors.get(id).workBudget.composes, 1);
});
test('member submissions share one durable counter and reject before creating queue entries', async t => {
  storageClock(t);
  const f = await acceptanceFixture();
  const id = member(f);
  const item = await f.makeCandidate([], [], {}, 'member');
  const request = f.request({
    agent: false,
    candidateId: item.candidate.id,
    expectedHead: item.candidate.result.head,
  });
  await f.enqueue(request, 'member');
  assert.equal(f.tables.projectContributors.get(id).workBudget?.submissions, 1);
  await f.enqueue(request, 'member');
  assert.equal(f.tables.projectContributors.get(id).workBudget.submissions, 1);
  f.patch('projectContributors', id, { workBudget: full() });
  const count = f.tables.projectHostedLandingRequests.size;
  await assert.rejects(f.enqueue({ ...request, operationId: randomUUID() }, 'member'), code('RATE_LIMITED'));
  assert.equal(f.tables.projectHostedLandingRequests.size, count);
});

test('concurrent member requests share the last budget unit atomically', async t => {
  storageClock(t);
  const f = await checksFixture(),
    id = member(f);
  f.patch('projectContributors', id, { workBudget: { ...full(), checks: MEMBER_WORK_BUDGET.checks - 1 } });
  const results = await Promise.allSettled([
    f.enqueue(f.selection(), 'member'),
    f.enqueue(f.selection(), 'member'),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected' && code('RATE_LIMITED')(r.reason)).length, 1);
  assert.equal(f.tables.projectContributors.get(id).workBudget.checks, MEMBER_WORK_BUDGET.checks);
  assert.equal(f.tables.projectHostedCheckRuns.size, 1);
});

test('a member at the submission cap cannot create a preparing goal or wake', async t => {
  storageClock(t);
  const f = await acceptanceFixture(),
    id = member(f);
  f.patch('projectContributors', id, { workBudget: full() });
  const desired = await import(moduleUrl('../convex/projectHostedLandingDesired.ts'));
  const tasks = f.pendingTasks().length;
  await assert.rejects(
    f.transaction(
      'desiredSubmit',
      desired.submit,
      {
        projectId: f.projectId,
        request: JSON.stringify({
          operationId: randomUUID(),
          authorityEpoch: 1,
          composeOperationId: randomUUID(),
          after: null,
          check: {
            kind: 'request',
            checkId: f.rawChecks.checkId,
            expectedDefinition: f.rawChecks.definition.digest,
            expectedConfiguration: f.rawChecks.configuration.digest,
            expectedEnvironment: f.rawChecks.runner.environmentFingerprint,
          },
        }),
      },
      'member',
    ),
    code('RATE_LIMITED'),
  );
  assert.equal(f.tables.projectHostedLandingDesired.size, 0);
  assert.equal(f.pendingTasks().length, tasks);
});

test('preparing member goals charge once per operation while aliases share the same goal', async () => {
  const f = await composeFixture(),
    id = member(f);
  // composeFixture reserves a synthetic pending task named task without executing it.
  // Original-goal replay now reads its scheduler state to repair only a lost wake.
  f.extendContext(ctx => {
    ctx.db.system = {
      get: async taskId => (taskId === 'task' ? { state: { kind: 'pending' } } : ctx.db.get(taskId)),
    };
  });
  const { policyPreset } = await import('../dist/autonomy-policy.js');
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: { ...policyPreset('trusted'), agentDefaults: { preflight: 'advise' } },
  });
  const selection = f.selection([await f.lane(f.baseline, { actor: 'member' })]);
  const call = (name, api, args) => f.call(name, api, { projectId: f.projectId, ...args }, 'member');
  await call('composePrepare', composeApi.prepare, { request: JSON.stringify(selection.request) });
  for (const kind of ['inputs', 'dependencies'])
    for (const [index, page] of selection.pages[kind].entries()) {
      f.put(saveBytes(page.value));
      await call('composeStage', composeApi.stage, {
        operationId: selection.request.operationId,
        kind,
        index,
        page: JSON.stringify(page.value),
      });
    }
  const progress = JSON.parse(
    await call('composeProgress', composeApi.progress, { operationId: selection.request.operationId }),
  );
  f.put(saveBytes(progress.input));
  const settings = {
    FORGE_SOURCE_PROVIDER: 'convex',
    FORGE_SOURCE_WORKER: 'fixed-worker',
    FORGE_SOURCE_RUNTIME: 'a'.repeat(64),
    FORGE_SOURCE_KEY_ID: 'SYNTHETIC',
  };
  const prior = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  try {
    await call('composeSubmit', composeJobs.submit, { operationId: selection.request.operationId });
    const desired = await import(moduleUrl('../convex/projectHostedLandingDesired.ts'));
    const command = {
      operationId: randomUUID(),
      authorityEpoch: 1,
      composeOperationId: selection.request.operationId,
      after: null,
      check: {
        kind: 'request',
        checkId: randomUUID(),
        expectedDefinition: 'a'.repeat(64),
        expectedConfiguration: 'b'.repeat(64),
        expectedEnvironment: 'c'.repeat(64),
      },
    };
    const submit = (request, memberBudget) =>
      call('desiredSubmit', desired.submit, {
        request: JSON.stringify(request),
        ...(memberBudget ? { memberBudget } : {}),
      }).then(JSON.parse);
    const goal = await submit(command);
    assert.equal(goal.phase, 'composing');
    assert.equal(f.tables.projectContributors.get(id).workBudget.submissions, 1);
    assert.equal((await submit(command)).id, goal.id);
    assert.equal(f.tables.projectContributors.get(id).workBudget.submissions, 1);
    const alias = { ...command, operationId: randomUUID() };
    assert.equal((await submit(alias)).id, goal.id);
    assert.equal(f.tables.projectContributors.get(id).workBudget.submissions, 2);
    await submit(alias);
    assert.equal(f.tables.projectContributors.get(id).workBudget.submissions, 2);
    assert.equal(f.tables.projectHostedLandingDesired.size, 1);
    const current = {
      ...full(),
      checks: MEMBER_WORK_BUDGET.checks - 2,
      submissions: MEMBER_WORK_BUDGET.submissions - 10,
    };
    const resetAt = new Date(current.day + MEMBER_WORK_BUDGET.windowMs).toISOString();
    f.patch('projectContributors', id, { workBudget: current });
    const { budget, ...storedGoal } = await submit({ ...command, operationId: randomUUID() }, true);
    assert.equal(storedGoal.id, goal.id);
    assert.deepEqual(budget, { limit: 'member-composes', left: 0, of: MEMBER_WORK_BUDGET.composes, resetAt });
    assert.equal(f.tables.projectContributors.get(id).workBudget.submissions, current.submissions + 1);
    assert.equal((await submit(command)).budget, undefined);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
