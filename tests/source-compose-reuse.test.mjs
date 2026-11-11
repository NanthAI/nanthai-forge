// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildComposePages } from '../dist/hosted-compose.js';
import { scaleFixture } from './convex-source-scale-fixture.mjs';
import { syncHistory } from './measure-sync-ancestry.mjs';
import { MemoryMergeSource } from '../dist/hosted-source-memory.js';

const ref = object => ({ object, recipe: null });
async function compose(s, main, head) {
  const inputs = buildComposePages([
    {
      laneId: '11111111-1111-4111-8111-111111111111',
      head: head.sha256,
      version: 0,
      sourceVersion: 0,
      lifecycleVersion: 0,
      state: ref(head),
    },
  ]);
  const dependencies = buildComposePages([]);
  for (const page of [...inputs.pages, ...dependencies.pages]) await s.json(page.value);
  return s.json({
    schema: 1,
    kind: 'forge-hosted-compose-input',
    base: { head: main.sha256, receiptId: 'main' },
    main: ref(main),
    inputs: inputs.manifest,
    dependencies: dependencies.manifest,
    algorithm: 'forge-native-compose-v1',
    message: 'compose',
    at: '2026-10-28T00:00:00.000Z',
  });
}
async function run(s, input) {
  const offset = s.events.length;
  const id = await s.enqueue(input),
    report = await s.drain();
  const job = await s.job(id);
  assert.equal(job.status, 'completed');
  const result = JSON.parse(await s.bytes(job.output));
  return { report, result, events: s.events.slice(offset) };
}
for (const direction of ['forward', 'already-contained', 'same-head'])
  test(`29k ${direction} compose finishes in one action, with no State or progress PUT`, async t => {
    const s = await scaleFixture();
    try {
      const h = await syncHistory(s, { files: 29000, changed: 1, distance: 1, conflict: false });
      const [main, head] =
        direction === 'forward'
          ? [h.base, h.lane]
          : direction === 'already-contained'
            ? [h.lane, h.base]
            : [h.lane, h.lane];
      const { report, result, events } = await run(s, await compose(s, main, head));
      assert.equal(result.result.status, 'clean');
      assert.equal(result.result.state.sha256, h.lane.sha256);
      assert.deepEqual(result.result.paths, direction === 'forward' ? [h.laneEdits.keys().next().value] : []);
      assert.equal(report.steps, 1, 'metadata-only finish never starts a second action');
      assert(report.functionCalls <= 8, 'compose control calls stay bounded');
      assert(
        events.filter(e => e.put !== undefined).every(e => e.put < 4096),
        'only the small result is written',
      );
      const logs = s.metrics.flatMap(m => m.sourceSteps);
      assert.equal(
        logs.reduce((n, step) => n + step.putBytes.state + step.putBytes.progress, 0),
        0,
      );
      const idle = await s.drain();
      assert.equal(idle.calls, 0);
      assert.equal(idle.readObjects, 0);
      t.diagnostic(JSON.stringify({ direction, ...report }));
    } finally {
      s.restore();
    }
  });

test('29k recompose reuses an exact stored State; a new main retains both changes and writes only its new State', async t => {
  const s = await scaleFixture();
  try {
    const h = await syncHistory(s, { files: 29000, changed: 1, distance: 1, conflict: false });
    const input = await compose(s, h.main, h.lane);
    const first = await run(s, input),
      repeated = await run(s, input);
    assert.deepEqual(repeated.result, first.result, 'new job, same pinned source and exact result');
    const merged = first.result.result.state;
    assert.equal(first.events.filter(e => e.digest === merged.sha256 && e.put !== undefined).length, 1);
    assert.equal(
      repeated.events.filter(e => e.digest === merged.sha256 && e.put !== undefined).length,
      0,
      'a recompose never re-uploads its unchanged State',
    );
    assert(repeated.report.functionCalls <= first.report.functionCalls);
    const edits = new Map(h.mainEdits);
    edits.set(
      'src/deep/shared/components/features/generated/module-000002.ts',
      (await h.blob('another-main')).sha256,
    );
    const main = await h.state([h.main], 'another main', edits);
    const moved = await run(s, await compose(s, main, h.lane));
    const bytes = await s.bytes(moved.result.result.state);
    const oracle = new MemoryMergeSource({});
    for (const pin of [h.base, h.main, main, h.lane]) {
      const raw = await s.bytes(pin);
      oracle.objects.set(pin.sha256, raw);
      oracle.parents[pin.sha256] = JSON.parse(raw).parents;
    }
    const expected = oracle.compose(main.sha256, h.lane.sha256, 'compose', '2026-10-28T00:00:00.000Z');
    assert.deepEqual(bytes, oracle.object(expected.head));
    assert.equal(moved.events.filter(e => e.put !== undefined && e.digest === merged.sha256).length, 0);
    t.diagnostic(JSON.stringify({ first: first.report, repeated: repeated.report, moved: moved.report }));
  } finally {
    s.restore();
  }
});
