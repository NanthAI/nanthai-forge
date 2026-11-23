// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 17ce38ba: CLI release signing must not wait on the GitHub mirror. On 2026-11-23 the mirror stopped
// (HTTP 502, Item a08b0d3a) and no main build after bcadb9b8 was signed, because the signer ran only on
// a mirror push. Forge now dispatches the signer from the landing itself (docs/operations/cli-update.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const dispatchModule = await import(moduleUrl('../convex/projectReleaseSignDispatch.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const DISPATCH = 'projectReleaseSignDispatch:dispatch';

/** Land every queued member against a refused mirror; record signer dispatches instead of calling GitHub. */
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
    // "refused" in nforge github status: GitHub refused Forge's push.
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
  // The project releases signed CLI builds: an earlier State was signed.
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
    if (task.name === DISPATCH) {
      dispatches.push(task.args[0]);
      f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
    } else await f.execute(task);
  }
  assert(states(f).every(s => s.phase === 'landed'));
  for (const task of f.pending().filter(task => task.name === DISPATCH)) dispatches.push(task.args[0]);
  return { f, dispatches };
}

for (const [label, options, autoPush] of [
  ['a solo landing, mirror auto-push on', { count: 1, batching: false }, true],
  ['a solo landing, mirror auto-push paused', { count: 1, batching: false }, false],
  ['a landing batch', { count: 3 }, true],
]) {
  test(`Item 17ce38ba: a refused mirror still gets main signed: ${label} dispatches the signer once with main's State`, async t => {
    const { f, dispatches } = await landWithRefusedMirror(t, options, autoPush);
    const main = f.currentMain();
    assert(dispatches.length >= 1 && dispatches.length <= options.count, 'at most one dispatch per landing');
    assert.deepEqual(dispatches.at(-1), {
      projectId: f.projectId,
      repository: 'synthetic/mirror',
      state: main.head,
      release: main.sourceRevision,
      attempt: 0,
    });
    // The refused mirror job is untouched: signing did not wait on it or wake it.
    assert.equal([...f.tables.projectGithubMirrorJobs.values()][0].status, 'failed');
  });
}

test('Item 17ce38ba: a project with no stored release signature dispatches nothing', async t => {
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
    assert.notEqual(task?.name, DISPATCH);
    if (task) await f.execute(task);
  }
  assert.equal(states(f)[0].phase, 'landed');
  assert(!f.pending().some(task => task.name === DISPATCH));
});

test('Item 17ce38ba: the dispatch names exactly the inputs the workflow declares, so GitHub accepts it', () => {
  const request = dispatchModule.releaseSignDispatchRequest({
    repository: 'o/r',
    state: 'c'.repeat(64),
    release: 7,
  });
  assert.equal(request.path, 'repos/o/r/actions/workflows/release-sign.yml/dispatches');
  assert.deepEqual(request.body, { ref: 'main', inputs: { state: 'c'.repeat(64), release: '7' } });
  const workflow = readFileSync(`.github/workflows/${dispatchModule.releaseSignWorkflow}`, 'utf8');
  const block = workflow.match(/^ {4}inputs:\n((?: {6}.*\n)+)/m);
  assert(block, 'the workflow declares workflow_dispatch inputs');
  const declared = [...block[1].matchAll(/^ {6}([\w-]+):$/gm)].map(m => m[1]);
  assert.deepEqual(declared.sort(), Object.keys(request.body.inputs).sort());
});

test('Item 17ce38ba: a transient dispatch failure retries a bounded number of times; a 4xx refusal does not', () => {
  const refused = dispatchModule.releaseSignRefused;
  for (const status of [400, 404, 422]) assert.equal(refused(status), true, String(status));
  for (const status of [undefined, 403, 429, 500, 502, 503])
    assert.equal(refused(status), false, String(status));
  assert.deepEqual(dispatchModule.releaseSignRetryMs, [60_000, 300_000, 900_000]);
});
