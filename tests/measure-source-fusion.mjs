// SPDX-License-Identifier: Apache-2.0
// Local qualification, no hosted workload. A/B interleave synthetic pipelines (three pairs per 29k shape for qualification).
// A uses three existing provider jobs; B uses one job with the same pinned stage inputs.
// This is source-only wall, never a measurement of time to accepted main or billed savings.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { scaleFixture, at } from './convex-source-scale-fixture.mjs';
import { buildSavePages, saveBytes, savePin } from '../dist/hosted-save.js';
import { buildComposePages } from '../dist/hosted-compose.js';
import { digest } from '../dist/hash.js';
const files = Number(process.argv[2] ?? 29000);
const pairs = Number(process.argv[3] ?? 11);
const destination = process.argv[4];
const ref = object => ({ object, recipe: null });
const laneId = '11111111-1111-4111-8111-111111111111';

async function fixture(fused, conflict, expectedPins) {
  const s = await scaleFixture(
    fused ? { nodeStepUrl: new URL('./source-fusion-probe.mjs', import.meta.url).href } : {},
  );
  const blob = await s.putSpec(Buffer.from('baseline\n'));
  const tree = Array.from({ length: files }, (_, i) => ({
    path: `src/deep/shared/components/features/generated/module-${String(i).padStart(6, '0')}.ts`,
    blob: blob.sha256,
    mode: 'file',
  }));
  const state = (files, parents, message) => ({
    schema: 1,
    kind: 'forge-source-state',
    files,
    parents,
    message,
    at,
  });
  const putState = async value =>
    s.putSpec(Buffer.from(JSON.stringify(value)), undefined, value.parents.length ? 2 : 1, {
      parents: value.parents,
    });
  const base = await putState(state(tree, [], 'base'));
  const left = await s.putSpec(Buffer.from('left\n')),
    right = await s.putSpec(Buffer.from('right\n'));
  const savedFiles = tree.map((file, i) => (i === 0 ? { ...file, blob: left.sha256 } : file));
  const mainFiles = tree.map((file, i) =>
    (conflict ? i === 0 : i === 1) ? { ...file, blob: right.sha256 } : file,
  );
  const main = await putState(state(mainFiles, [base.sha256], 'main'));
  const pages = buildSavePages([
    {
      path: tree[0].path,
      before: { blob: blob.sha256, mode: 'file' },
      after: { blob: left.sha256, mode: 'file', content: ref(left) },
    },
  ]);
  for (const page of pages.pages) await s.json(page.value);
  const save = await s.json({
    schema: 1,
    kind: 'forge-hosted-save-input',
    baseline: ref(base),
    pages: pages.root,
    pageCount: pages.pages.length,
    changeCount: 1,
    message: 'save',
    at,
  });
  // Match native State field order. Expected States are computed, never seeded into R2.
  const nativeState = (files, parents, message) => ({
    schema: 1,
    kind: 'forge-source-state',
    parents,
    files,
    message,
    at,
  });
  const pinState = value => {
    const b = Buffer.from(JSON.stringify(value));
    return { sha256: digest(b), size: b.length };
  };
  const saved = pinState(nativeState(savedFiles, [base.sha256], 'save'));
  const sync = await s.json({
    schema: 1,
    kind: 'forge-hosted-sync-input',
    algorithm: 'forge-native-sync-v1',
    work: { mode: 'sync', left: ref(saved), right: ref(main) },
    message: 'sync',
    at,
  });
  const syncedFiles = savedFiles.map((file, i) =>
    (conflict ? i === 0 : i === 1) ? { ...file, blob: right.sha256 } : file,
  );
  const synced = expectedPins?.[1] ?? pinState(nativeState(syncedFiles, [saved.sha256, main.sha256], 'sync'));
  const inputs = buildComposePages([
    { laneId, head: synced.sha256, version: 2, sourceVersion: 2, lifecycleVersion: 0, state: ref(synced) },
  ]);
  const dependencies = buildComposePages([]);
  for (const page of [...inputs.pages, ...dependencies.pages]) await s.json(page.value);
  const compose = await s.json({
    schema: 1,
    kind: 'forge-hosted-compose-input',
    base: { head: main.sha256, receiptId: 'main' },
    main: ref(main),
    inputs: inputs.manifest,
    dependencies: dependencies.manifest,
    algorithm: 'forge-native-compose-v1',
    message: 'compose',
    at,
  });
  const stages = [save, sync, compose];
  const input = fused ? await s.json({ schema: 1, kind: 'forge-source-fusion-probe', stages, base }) : null;
  return {
    s,
    stages,
    input,
    expected: expectedPins ?? (conflict ? null : [saved, synced, synced]),
    base,
    main,
    makeCompose: async head => {
      const entries = buildComposePages([
        { laneId, head: head.sha256, version: 2, sourceVersion: 2, lifecycleVersion: 0, state: ref(head) },
      ]);
      for (const page of entries.pages) await s.json(page.value);
      const plan = JSON.parse(await s.bytes(compose));
      return s.json({ ...plan, inputs: entries.manifest });
    },
  };
}

async function run(fused, conflict, expectedPins) {
  const { s, stages, input, expected, base, makeCompose } = await fixture(fused, conflict, expectedPins);
  try {
    const start = s.events.length,
      phaseMemory = [],
      runs = [],
      actual = [],
      ids = [];
    for (const pin of fused ? [input] : stages) {
      const id = await s.enqueue(pin);
      ids.push(id);
      runs.push(await s.drain({ memoryBound: false }));
      const job = await s.job(id);
      assert.equal(job.status, 'completed', JSON.stringify(job.control));
      const value = JSON.parse(await s.bytes(job.output));
      if (fused) {
        actual.push(...value.results.map(v => v.result));
        phaseMemory.push(...value.phases);
      } else {
        actual.push(value);
        phaseMemory.push({ stage: actual.length - 1, maxRssBytes: runs.at(-1).maxRssBytes });
        if (actual.length === 2 && conflict) stages[2] = await makeCompose(value.result.state);
      }
    }
    const pins = actual.map(value => value.state ?? value.result.state);
    if (expected)
      assert.deepEqual(pins, expected, 'all three exact State pins match the unfused native path');
    const puts = s.events.slice(start).filter(event => event.put !== undefined);
    const logs = s.metrics.flatMap(metric => metric.sourceSteps ?? []);
    const bodyBytes = Object.fromEntries(
      ['state', 'progress', 'result', 'other', 'refused', 'avoided'].map(kind => [
        kind,
        logs.reduce((sum, step) => sum + (step.putBytes?.[kind] ?? 0), 0),
      ]),
    );
    assert.equal(
      puts.reduce((sum, event) => sum + event.put, 0),
      bodyBytes.state + bodyBytes.progress + bodyBytes.result + bodyBytes.other,
      'actual R2 attempted bodies reconcile to the source transport counters',
    );
    const sourceSteps = [...s.tables.projectSourceSteps.values()].filter(row => ids.includes(row.jobId));
    const summary = {
      jobs: ids.length,
      actions: runs.reduce((sum, run) => sum + run.steps, 0),
      calls: runs.reduce((sum, run) => sum + run.calls, 0),
      wallMs: runs.reduce((sum, run) => sum + run.wallMs, 0),
      maxRssBytes: Math.max(...runs.map(run => run.maxRssBytes)),
      attemptedPutBytes: puts.reduce((sum, event) => sum + event.put, 0),
      attemptedStatePutBytes: bodyBytes.state,
      bodyBytes,
      baseReads: s.readCounts.get(base.sha256),
      dbReadBytes: s.counts.reduce((sum, row) => sum + row.readBytes, 0),
      dbWriteBytes: s.counts.reduce((sum, row) => sum + row.writeBytes, 0),
      phases: sourceSteps.flatMap(row =>
        row.timing.steps.map(step => ({ phase: step.phase, stop: step.stop })),
      ),
      pins,
      results: actual,
      phaseMemory,
    };
    const idle = await s.drain({ memoryBound: false });
    assert.equal(idle.calls, 0);
    assert.equal(idle.readObjects, 0);
    return summary;
  } finally {
    s.restore();
  }
}
const report = {
  method:
    'source-only synthetic provider handlers; A uses three jobs with compose fix, B releases phase trees and caches (8 MiB maximum, base only save->sync); no live billing or main acceptance',
  files,
  pairs: [],
};
for (const conflict of [false, true])
  for (let i = 0; i < pairs; i++) {
    const a = await run(false, conflict),
      b = await run(true, conflict, a.pins);
    assert.deepEqual(b.results, a.results, 'all exact result manifests, including conflict roots, match');
    report.pairs.push({ conflict, a, b });
    process.stdout.write(JSON.stringify({ conflict, pair: i + 1, a, b }) + '\n');
    if (destination) writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
  }
