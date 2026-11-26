// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import test from 'node:test';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { landingStateOf } from '../dist/landing-state.js';
import { moduleUrl } from './convex-module.mjs';
import { writePhysicalManifest } from '../dist/physical-manifest-write.js';

const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('a failed recompose invariant stops the cohort and alerts its owner once', async t => {
  const source = await import(moduleUrl('../convex/projectConvexSourceStore.ts'));
  const needs = await import(moduleUrl('../convex/projectNeedsMe.ts'));
  const f = await batchesFixture(t);
  for (let i = 0; !f.tables.projectSourceSteps.size; i++) {
    assert(i < 40);
    await f.execute(f.pending()[0]);
  }
  const step = [...f.tables.projectSourceSteps.values()][0];
  const composes = f.tables.projectHostedComposes.size;
  const message = 'The recompose Candidate delta failed verification.';
  await f.tx('failRecomposeInvariant', source.commit, {
    projectId: step.projectId,
    jobId: step.jobId,
    step: step.step,
    cursor: null,
    objects: [],
    output: null,
    failure: 'SOURCE_RECOMPOSE_INVARIANT',
    failureReason: message,
  });
  await f.drain();
  assert(
    states(f).every(
      state =>
        state.phase === 'terminal-failed' &&
        state.error.code === 'SOURCE_RECOMPOSE_INVARIANT' &&
        state.error.message === message,
    ),
  );
  assert.equal(f.tables.projectHostedComposes.size, composes);
  assert.equal(f.runs().length, 0);
  const dashboard = await f.tx('needsRecomposeReview', needs.read, { projectId: step.projectId });
  assert.deepEqual(
    dashboard.notices.map(notice => [notice.kind, notice.summary]),
    [['source-proof', message]],
  );
  for (const mark of f.tables.projectLiveLineLanes.values())
    f.patch('projectLiveLineLanes', mark._id, { held: false });
  const outsideHeldPage = await f.tx('needsAfterLaneClears', needs.read, { projectId: step.projectId });
  assert.deepEqual(outsideHeldPage.notices, dashboard.notices);
});

test('a solo recompose failure remains terminal when main moves before installation', async t => {
  const f = await batchesFixture(t, { count: 1, batching: false });
  const source = await import(moduleUrl('../convex/projectConvexSourceStore.ts'));
  f.moveMain();
  for (let i = 0; !f.tables.projectSourceSteps.size; i++) {
    assert(i < 60);
    const task = f.pending()[0];
    assert(task, 'the moved main has an active source operation');
    await f.execute(task);
  }
  const step = [...f.tables.projectSourceSteps.values()][0];
  const row = [...f.tables.projectHostedLandingRequests.values()][0];
  f.patch('projectHostedLandingRequests', row._id, {
    value: JSON.stringify({ ...JSON.parse(row.value), batchNeedsSoloCompose: true }),
  });
  f.moveMain({ files: [['second-main.txt', 'accepted after the failure began']] });
  await f.tx('commitSoloRecomposeFailure', source.commit, {
    projectId: step.projectId,
    jobId: step.jobId,
    step: step.step,
    cursor: null,
    objects: [],
    output: null,
    failure: 'SOURCE_RECOMPOSE_INVARIANT',
    failureReason: 'The exact source proof changed.',
  });
  const jobs = f.tables.projectSourceSteps.size;
  await f.drain();
  assert.equal(f.tables.projectSourceSteps.size, jobs);
  const [landing] = states(f);
  assert.equal(landing.phase, 'terminal-failed');
  assert.equal(landingStateOf(landing).state, 'recompose-stopped');
});

test('the initial cohort signs exact deltas and reuses physical bindings through source publication', async t => {
  const priorPhysical = process.env.FORGE_PHYSICAL_MANIFESTS;
  process.env.FORGE_PHYSICAL_MANIFESTS = '1';
  t.after(() => {
    if (priorPhysical === undefined) delete process.env.FORGE_PHYSICAL_MANIFESTS;
    else process.env.FORGE_PHYSICAL_MANIFESTS = priorPhysical;
  });

  const paths = [];
  const warn = console.warn;
  t.mock.method(console, 'warn', (line, ...args) => {
    if (typeof line === 'string' && line.includes('"event":"forge-source-step"')) {
      paths.push(JSON.parse(line).path);
      return;
    }
    warn(line, ...args);
  });
  const run = async withDeltas => {
    const f = await batchesFixture(t, {
      count: 3,
      fileCount: 2,
      startAt: Date.parse('2026-11-26T00:00:00Z'),
    });
    const start = paths.length;
    const main = f.moveMain();
    const memberCandidates = new Set(f.entries.map(entry => entry.state.request.candidateId));
    const candidates = [...f.tables.projectHostedRecords.values()].filter(
      row => row.kind === 'candidate' && memberCandidates.has(row.key),
    );
    assert.equal(candidates.filter(row => row.candidateFilesDirect).length, 3);
    if (!withDeltas)
      for (const candidate of candidates)
        f.patch('projectHostedRecords', candidate._id, { candidateFilesDirect: undefined });
    const stateRows = [...f.tables.projectObjects.values()].filter(row => {
      const bytes = f.c.objects.get(row.digest);
      return bytes && Buffer.from(bytes).toString().startsWith('{"schema":1,"kind":"forge-source-state",');
    });
    for (const row of stateRows) {
      const state = JSON.parse(f.c.objects.get(row.digest));
      const manifest = await writePhysicalManifest({
        state: row.digest,
        members: state.files.map(file => file.blob),
        put: async bytes => f.c.put(Buffer.from(bytes)),
        describe: async ids => ids.map(sha256 => ({ sha256, size: f.c.objects.get(sha256).length })),
      });
      f.patch('projectObjects', row._id, {
        statePhysical: manifest.pin,
        stateParents: state.parents,
        stateGeneration: state.parents.length ? 2 : 1,
      });
    }
    const before = f.counts.length;
    await f.drain();
    const composed = [...f.tables.projectHostedComposes.values()].filter(row => JSON.parse(row.value).batch);
    assert.equal(composed.length, 1);
    const value = JSON.parse(composed[0].value);
    assert.equal(value.status, 'completed');
    const result = [...f.tables.projectHostedStates.values()].find(row => row.jobId === composed[0].jobId);
    assert(result, 'the Node commit published its trusted candidate');
    const output = JSON.parse(f.c.objects.get(result.output));
    const state = [...f.tables.projectObjects.values()].find(row => row.digest === result.head);
    assert(state.statePhysical);
    return {
      state: output.result.state,
      main: main.head,
      paths: paths.slice(start),
      reads: f.counts.slice(before).reduce((n, row) => n + row.documents, 0),
      resolves: f.metrics.convexSourceCalls.filter(call => call === 'projectConvexSourceObjects:resolve')
        .length,
    };
  };
  const ordinary = await run(false);
  const fast = await run(true);
  assert.deepEqual(fast.state, ordinary.state);
  assert.deepEqual(fast.paths, ['node-fast-disjoint']);
  assert(fast.resolves <= ordinary.resolves);
  assert(fast.reads <= ordinary.reads);
  t.diagnostic(JSON.stringify({ ordinary, fast }));
});
