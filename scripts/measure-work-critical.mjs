// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export async function measureWorkCritical(runtime) {
  const load = name => import(pathToFileURL(join(runtime, 'dist', name + '.js')).href);
  const [{ AgentWorkflow }, { initNative }, { NativeSource }] = await Promise.all(
    ['agent-workflow', 'native-work', 'native-source'].map(load),
  );
  const root = fs.mkdtempSync(join(tmpdir(), 'forge-critical-measure-')),
    count = 128,
    bytes = 65536;
  const fsync = fs.fsyncSync;
  let metrics,
    inside = false;
  try {
    for (let i = 0; i < count; i++) fs.writeFileSync(join(root, `source-${i}.bin`), Buffer.alloc(bytes, i));
    initNative(root);
    const agent = new AgentWorkflow(root),
      store = agent.work.store;
    const lane = (
      await agent.dispatch({
        action: 'start',
        operationId: randomUUID(),
        outcome: 'Critical section measurement',
        channel: null,
      })
    ).result;
    for (let i = 0; i < count; i++)
      fs.appendFileSync(join(lane.path, `source-${i}.bin`), Buffer.from([255 - i]));
    const original = store.locked.bind(store);
    store.locked = run => {
      const start = performance.now();
      inside = true;
      try {
        return original(() => {
          const start = performance.now();
          try {
            return run();
          } finally {
            metrics.heldMs += performance.now() - start;
          }
        });
      } finally {
        metrics.lockedMs += performance.now() - start;
        inside = false;
      }
    };
    fs.fsyncSync = (...args) => {
      metrics.fsyncs++;
      if (inside) metrics.lockedFsyncs++;
      return fsync(...args);
    };
    syncBuiltinESMExports();
    const measure = async run => {
      metrics = { heldMs: 0, lockedMs: 0, fsyncs: 0, lockedFsyncs: 0 };
      const start = performance.now(),
        result = await run();
      return { result, ...metrics, totalMs: performance.now() - start };
    };
    const checkpoint = await measure(() =>
      agent.dispatch({
        action: 'checkpoint',
        operationId: randomUUID(),
        laneId: lane.laneId,
        expectedHead: lane.head,
        message: 'Change every source file',
      }),
    );
    const note = await measure(() =>
      agent.work.dispatch(
        { action: 'note', intentId: lane.intentId, kind: 'decision', text: 'Preserve all original records' },
        store.revision(),
        { compact: true },
      ),
    );
    const state = new NativeSource(root).state(checkpoint.result.result.head);
    assert.equal(state.files.length, count);
    for (const file of state.files) assert.equal(new NativeSource(root).object(file.blob).length, bytes + 1);
    assert.equal(store.load().intents[0].notes.length, 1);
    assert.equal(store.load().lanes[0].checkpoints.length, 1);
    const { result: _cp, ...checkpointMetrics } = checkpoint,
      { result: _note, ...noteMetrics } = note;
    void _cp;
    void _note;
    return {
      runtime,
      node: process.version,
      platform: process.platform,
      sourceFiles: count,
      sourceBytes: count * bytes,
      checkpoint: checkpointMetrics,
      note: noteMetrics,
      sourceAndRecordsVerified: true,
      disposableOwnerRemoved: true,
      scope:
        'One real local 128-file checkpoint and compact note. Timings include local filesystem work; not hosted or eight-agent throughput.',
    };
  } finally {
    fs.fsyncSync = fsync;
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const script = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === script) {
  const output = process.argv[2];
  assert(output, 'Supply a private JSON result path');
  const result = await measureWorkCritical(process.argv[3] ?? dirname(dirname(script)));
  fs.writeFileSync(output, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
}
