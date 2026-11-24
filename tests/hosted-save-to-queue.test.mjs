// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Review a661e1c1 (Item 411727ba, Lane 786f816a): the queue suites seed saved Lane heads directly, so
// an unconditional throw at the entry of submitHostedSave left them green. This journey makes a real
// save through the final-page submit, publishes it, and lands the Lane it produced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { saveBytes, buildSavePages } from '../dist/hosted-save.js';

const saves = await import(moduleUrl('../convex/projectHostedSaves.ts'));
const saveJobs = await import(moduleUrl('../convex/projectHostedSaveJobs.ts'));
const runStore = await import(moduleUrl('../convex/projectSourceRunStore.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** One real save of `text` over a.txt on a fresh Lane: prepare, final-page submit (the split-save
 * path an agent uses), source job, publish. Returns the Lane entry a Candidate composes from. */
async function savedLane(c, text) {
  const base = await c.lane(c.baseline);
  const pin = c.put(text);
  const built = buildSavePages([
    {
      path: 'a.txt',
      before: { blob: c.baseFile.blob, mode: 'file' },
      after: { blob: pin.sha256, mode: 'file', content: { object: pin, recipe: null } },
    },
  ]);
  const request = {
    operationId: randomUUID(),
    laneId: base.laneId,
    authorityEpoch: 1,
    expected: {
      head: base.head,
      version: base.version,
      sourceVersion: base.sourceVersion,
      lifecycleVersion: base.lifecycleVersion,
    },
    message: 'synthetic save',
    pages: built.root,
    pageCount: built.pages.length,
    changeCount: 1,
  };
  const projectId = c.projectId;
  const prepared = JSON.parse(
    await c.call('prepare', saves.prepare, { projectId, request: JSON.stringify(request) }),
  );
  const [page] = built.pages;
  c.put(saveBytes(page.value));
  c.put(saveBytes(prepared.input));
  const submitted = JSON.parse(
    JSON.parse(
      await c.call('saveSubmit', runStore.submit, {
        projectId,
        operationId: request.operationId,
        actor: 'owner',
        kind: 'save',
        background: true,
        index: 0,
        page: JSON.stringify(page.value),
      }),
    ).payload,
  );
  assert.equal(submitted.status, 'submitted');
  const saved = JSON.parse(
    await c.call('progress', saves.progress, { projectId, operationId: request.operationId }),
  );
  const output = await c.compute(saved.input);
  const row = [...c.tables.projectHostedSaves.values()].find(r => r.operationId === request.operationId);
  const job = await c.activate(row.jobId);
  await c.callback(job, { status: 'completed', output: output.output });
  const terminal = JSON.parse(
    await c.call('publish', saveJobs.publish, { projectId, jobId: row.jobId, result: output.manifest }),
  );
  assert.equal(terminal.outcome.status, 'completed');
  const { head, version, sourceVersion } = terminal.outcome.result;
  return {
    laneId: base.laneId,
    head,
    version,
    sourceVersion,
    lifecycleVersion: base.lifecycleVersion,
    state: { object: { sha256: head, size: c.objects.get(head).length }, recipe: null },
  };
}

test('a real final-page save submit reaches the landing queue and lands its Lane head (review a661e1c1)', async t => {
  const f = await batchesFixture(t, { count: 0, batching: false });
  const state = await f.add(0, { laneFrom: c => savedLane(c, 'saved through submitHostedSave\n') });
  const submit = f.counts.filter(row => row.name === 'saveSubmit');
  assert.equal(submit.length, 1, 'one submit mutation for the final page');
  assert.equal(submit[0].readDocumentsByTable.projectHostedSaves, 1, 'the submit reads its save once');
  assert.notEqual(states(f).find(s => s.id === state.id).phase, 'landed');
  for (let tick = 0; tick < 400 && states(f)[0].phase !== 'landed'; tick++) {
    for (const run of f.runs().filter(run => run.status === 'queued'))
      await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    const task = f.pending()[0];
    if (task) await f.execute(task);
  }
  assert.equal(states(f)[0].phase, 'landed');
  const files = JSON.parse(f.c.objects.get(f.currentMain().head)).files;
  const a = files.find(file => file.path === 'a.txt');
  assert.equal(f.c.objects.get(a.blob).toString(), 'saved through submitHostedSave\n');
});
