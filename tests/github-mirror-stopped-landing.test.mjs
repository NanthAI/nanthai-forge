// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Friction 28e84c06 (Item 67771ca6): while the GitHub mirror was stopped a builder polled GitHub for
// 25 minutes for a landing that could not arrive. A landed reply now names the stopped mirror; a
// pending reply reads no mirror row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { landSummary } from '../dist/hosted-land-summary.js';
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('friction 28e84c06: a landed reply names the stopped GitHub mirror; a pending reply does not', async t => {
  const f = await batchesFixture(t, { count: 1, batching: false });
  const [entry] = f.entries;
  const page = async () =>
    JSON.parse(
      await f.tx('mirrorStoppedPage', observe.page, {
        projectId: f.projectId,
        operationId: entry.state.operationId,
        nextVersion: 0,
      }),
    );
  // The stopped mirror of incident 67771ca6: its active job failed terminally.
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
    error: 'GITHUB_SYNC_HASH',
    detail: 'GitHub commit differs from the deterministic mirror commit.',
  });
  f.insert('projectGithubMirrors', {
    projectId: f.projectId,
    repository: 'synthetic/mirror',
    activeId: jobId,
    mapping: null,
  });
  f.insert('projectGithubMirrorStops', { projectId: f.projectId, jobId });
  const policy = f.tables.hostedProjects.get(f.projectId).autonomyPolicy;
  const mirrorOn = { ...policy, githubMirror: { repo: 'synthetic/mirror', autoPush: true, laneRefs: false } };
  f.patch('hostedProjects', f.projectId, { autonomyPolicy: mirrorOn });
  assert.notEqual(states(f)[0].phase, 'landed');
  assert.equal((await page()).mirrorStopped, undefined, 'a pending reply names no mirror');
  for (let tick = 0; tick < 400 && states(f)[0].phase !== 'landed'; tick++) {
    for (const run of f.runs().filter(run => run.status === 'queued'))
      await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    const task = f.pending()[0];
    if (task) await f.execute(task);
  }
  assert.equal(states(f)[0].phase, 'landed');
  const landed = await page();
  const stopped = {
    repository: 'synthetic/mirror',
    error: 'GITHUB_SYNC_HASH',
    state: 'a'.repeat(64),
    receiptId: '893d4653-e7a5-4d1b-8639-8f9ec839a8ee',
  };
  assert.deepEqual(landed.mirrorStopped, stopped);
  assert.deepEqual(landed.events.at(-1).mirrorStopped, stopped);
  // The line land and wait print with LANDED.
  const lines = landSummary({
    result: {
      phase: 'finish',
      submission: { phase: 'landed', acceptance: { receiptId: 'r1' } },
      mirrorStopped: stopped,
    },
  });
  assert.equal(lines[0], 'LANDED receipt r1');
  assert.match(
    lines.at(-1),
    /^GitHub mirror to synthetic\/mirror is stopped \(GITHUB_SYNC_HASH at receipt 893d4653\): this landing is on Forge main but does not reach GitHub until the project owner resumes the mirror\. nforge github status \. names the cause\.$/,
  );
  // A paused mirror is not reported as stopped (review finding: pause and disconnect).
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: { ...mirrorOn, githubMirror: { ...mirrorOn.githubMirror, autoPush: false } },
  });
  assert.equal((await page()).mirrorStopped, undefined);
  f.patch('hostedProjects', f.projectId, { autonomyPolicy: mirrorOn });
  // A healthy mirror adds nothing to LANDED.
  f.patch('projectGithubMirrorJobs', jobId, { status: 'done' });
  assert.equal((await page()).mirrorStopped, undefined);
});
