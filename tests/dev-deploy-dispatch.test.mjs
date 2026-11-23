// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 8b6efb50: dev Convex and web deploys start straight from Forge landings via workflow_dispatch,
// never waiting on the GitHub mirror push. Covers refused/paused mirrors, batch landings, path
// selection, workflow input contract, and transient retry vs 4xx refusal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const deployModule = await import(moduleUrl('../convex/projectDeployDispatch.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const SIGN_DISPATCH = 'projectReleaseSignDispatch:dispatch';
const DEPLOY_DISPATCH = 'projectDeployDispatch:dispatch';

/** Land queued members against a refused mirror; collect scheduled deploy dispatches without hitting GitHub. */
async function landWithRefusedMirror(t, options, autoPush) {
  const f = await batchesFixture(t, options);
  const jobId = f.insert('projectGithubMirrorJobs', {
    projectId: f.projectId,
    receiptId: '893d4653-e7a5-4d1b-8639-8f9ec839a8ee',
    sequence: 1,
    repository: 'synthetic/mirror',
    authorityEpoch: 1,
    status: 'failed',
    state: 'a'.repeat(64),
    step: 3,
    cursor: null,
    error: 'GITHUB_SYNC_API',
  });
  f.insert('projectGithubMirrors', {
    projectId: f.projectId,
    repository: 'synthetic/mirror',
    activeId: jobId,
    mapping: null,
  });
  f.insert('projectGithubMirrorStops', { projectId: f.projectId, jobId });
  const policy = f.tables.hostedProjects.get(f.projectId).autonomyPolicy;
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: { ...policy, githubMirror: { repo: 'synthetic/mirror', autoPush, laneRefs: false } },
  });
  f.insert('projectReleaseSignatures', {
    projectId: f.projectId,
    head: 'b'.repeat(64),
    keyId: 'k',
    signature: 's',
    release: 1,
    actor: 'release-key:k',
    at: 1,
  });
  const dispatches = [];
  for (let tick = 0; tick < 800 && states(f).some(s => s.phase !== 'landed'); tick++) {
    for (const run of f.runs().filter(run => run.status === 'queued'))
      await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    const task = f.pending()[0];
    if (!task) continue;
    if (task.name === SIGN_DISPATCH || task.name === DEPLOY_DISPATCH) {
      if (task.name === DEPLOY_DISPATCH) dispatches.push(task.args[0]);
      f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
    } else await f.execute(task);
  }
  assert(states(f).every(s => s.phase === 'landed'));
  for (const task of f.pending().filter(task => task.name === DEPLOY_DISPATCH)) dispatches.push(task.args[0]);
  return { f, dispatches };
}

for (const [label, options, autoPush] of [
  [
    'a solo landing, mirror auto-push on',
    { count: 1, batching: false, memberPaths: [['convex/a.ts', 'web/b.ts']] },
    true,
  ],
  [
    'a solo landing, mirror auto-push paused',
    { count: 1, batching: false, memberPaths: [['convex/a.ts', 'web/b.ts']] },
    false,
  ],
  ['a landing batch', { count: 3, memberPaths: [['convex/a.ts'], ['web/b.ts'], ['docs/c.md']] }, true],
]) {
  test(`Item 8b6efb50: a refused mirror still dispatches dev deploys: ${label} dispatches once with main State`, async t => {
    const { f, dispatches } = await landWithRefusedMirror(t, options, autoPush);
    const main = f.currentMain();
    const byTarget = new Map();
    for (const d of dispatches) byTarget.set(d.target, [...(byTarget.get(d.target) ?? []), d]);
    assert.deepEqual([...byTarget.keys()].sort(), ['convex', 'web']);
    for (const target of ['convex', 'web']) {
      assert(
        byTarget.get(target).length >= 1 && byTarget.get(target).length <= options.count,
        `at most one ${target} dispatch per landing batch`,
      );
      assert.deepEqual(byTarget.get(target).at(-1), {
        projectId: f.projectId,
        repository: 'synthetic/checks',
        target,
        state: main.head,
        sequence: main.sourceRevision,
        attempt: 0,
      });
    }
    // The refused mirror job stays untouched: deploys never wait on or wake the mirror.
    assert.equal([...f.tables.projectGithubMirrorJobs.values()][0].status, 'failed');
  });
}

test('Item 8b6efb50: dispatch uses configured CI adapter repository over mirror repo and coalesces bursts', async t => {
  const f = await batchesFixture(t, {
    count: 1,
    batching: false,
    memberPaths: [['convex/a.ts', 'web/b.ts']],
  });
  const policy = f.tables.hostedProjects.get(f.projectId).autonomyPolicy;
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...policy,
      githubMirror: { repo: 'retargeted/mirror-only', autoPush: false, laneRefs: false },
    },
  });
  const existingRunner = [...f.tables.projectHostedCheckSettings.values()].find(
    r => r.projectId === f.projectId && r.kind === 'runner' && r.key === 'runner',
  );
  assert(existingRunner, 'fixture sets up a github-actions runner');
  f.patch('projectHostedCheckSettings', existingRunner._id, {
    value: JSON.stringify({ ...JSON.parse(existingRunner.value), repository: 'owner/ci-workflows' }),
  });
  f.insert('projectReleaseSignatures', {
    projectId: f.projectId,
    head: 'b'.repeat(64),
    keyId: 'k',
    signature: 's',
    release: 1,
    actor: 'release-key:k',
    at: 1,
  });
  const dispatches = [];
  for (let tick = 0; tick < 800 && states(f).some(s => s.phase !== 'landed'); tick++) {
    for (const run of f.runs().filter(run => run.status === 'queued'))
      await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    const task = f.pending()[0];
    if (!task) continue;
    if (task.name === SIGN_DISPATCH || task.name === DEPLOY_DISPATCH) {
      if (task.name === DEPLOY_DISPATCH) dispatches.push(task.args[0]);
      f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
    } else await f.execute(task);
  }
  for (const task of f.pending().filter(task => task.name === DEPLOY_DISPATCH)) dispatches.push(task.args[0]);
  assert.equal(dispatches.length, 2);
  for (const d of dispatches) assert.equal(d.repository, 'owner/ci-workflows');
  // Queued markers hold the coalesced tip per target so a follow-up landing before dispatch fires patches in place.
  const queued = [...f.tables.projectDeploys.values()].filter(row => row.status === 'queued');
  assert.equal(queued.length, 2);
});

test('Item 8b6efb50: a test-only landing dispatches zero dev deploys', async t => {
  const { dispatches } = await landWithRefusedMirror(
    t,
    { count: 1, batching: false, memberPaths: [['tests/only.test.mjs']] },
    false,
  );
  assert.equal(dispatches.length, 0);
});

test('Item 8b6efb50: a project with no stored release signature dispatches no dev deploys', async t => {
  const f = await batchesFixture(t, { count: 1, batching: false });
  const policy = f.tables.hostedProjects.get(f.projectId).autonomyPolicy;
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...policy,
      githubMirror: { repo: 'synthetic/mirror', autoPush: false, laneRefs: false },
    },
  });
  for (let tick = 0; tick < 400 && states(f)[0].phase !== 'landed'; tick++) {
    for (const run of f.runs().filter(run => run.status === 'queued'))
      await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    const task = f.pending()[0];
    assert.notEqual(task?.name, DEPLOY_DISPATCH);
    if (task) await f.execute(task);
  }
  assert.equal(states(f)[0].phase, 'landed');
  assert(!f.pending().some(task => task.name === DEPLOY_DISPATCH));
});

test('Item 8b6efb50: selectDeployTargets routes only affected workflows and skips test-only landings', () => {
  assert.deepEqual(deployModule.selectDeployTargets(['tests/a.test.mjs']), []);
  assert.deepEqual(deployModule.selectDeployTargets(['web/src/app/App.tsx']), ['web']);
  assert.deepEqual(deployModule.selectDeployTargets(['docs/development.md']), ['web']);
  assert.deepEqual(deployModule.selectDeployTargets(['convex/schema.ts']), ['convex', 'web']);
  assert.deepEqual(deployModule.selectDeployTargets(['src/cli.ts']), ['convex', 'web']);
  assert.deepEqual(deployModule.selectDeployTargets(null), ['convex', 'web']);
});

test('Item 8b6efb50: dispatch inputs match both deploy workflows so GitHub never refuses with 422', () => {
  for (const target of ['convex', 'web']) {
    const request = deployModule.deployDispatchRequest({
      repository: 'o/r',
      target,
      state: 'c'.repeat(64),
      sequence: 42,
    });
    assert.equal(
      request.path,
      `repos/o/r/actions/workflows/${deployModule.deployWorkflows[target]}/dispatches`,
    );
    assert.deepEqual(request.body, { ref: 'main', inputs: { state: 'c'.repeat(64), sequence: '42' } });
    const workflow = readFileSync(`.github/workflows/${deployModule.deployWorkflows[target]}`, 'utf8');
    const block = workflow.match(/^ {4}inputs:\n((?: {6}.*\n)+)/m);
    assert(block, `${target} workflow declares workflow_dispatch inputs`);
    const declared = [...block[1].matchAll(/^ {6}([\w-]+):$/gm)].map(m => m[1]);
    assert.deepEqual(declared.sort(), Object.keys(request.body.inputs).sort());
  }
});

test('Item 8b6efb50: explicit non-accepted statuses (429/503) retry with bounded backoff; 4xx and ambiguous POST gateway/timeout errors do not', () => {
  const retryable = deployModule.deployDispatchRetryable;
  for (const status of [400, 403, 404, 422, 500, 502, 504, undefined])
    assert.equal(retryable(status, 'post'), false, `post ${status}`);
  for (const status of [429, 503]) assert.equal(retryable(status, 'post'), true, `post ${status}`);
  assert.equal(retryable(undefined, 'token'), true, 'token mint network loss retries before POST');
  assert.equal(retryable(502, 'token'), true, 'token mint 502 retries before POST');
  assert.equal(retryable(404, 'token'), false);
  assert.deepEqual(deployModule.deployRetryMs, [60_000, 300_000, 900_000]);
});
