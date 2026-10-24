// SPDX-License-Identifier: Apache-2.0
// Synthetic local owners only. Run after build:core; values are wall time, not production estimates.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { initNative } from '../dist/native-work.js';
import { policyPreset } from '../dist/autonomy-policy.js';
import { drainPostAccept } from '../dist/post-accept-main.js';
import { NativeSource } from '../dist/native-source.js';

async function measure(count, optimistic, breaking = false) {
  const root = mkdtempSync(join(tmpdir(), 'forge-landing-bench-'));
  writeFileSync(join(root, 'seed.txt'), 'synthetic\n');
  initNative(root);
  const agent = new AgentWorkflow(root),
    store = agent.work.store;
  const queueBefore = process.env.FORGE_CHECK_QUEUE_DIR;
  process.env.FORGE_CHECK_QUEUE_DIR = join(store.directory, 'bench-queue');
  try {
    store.locked(() => {
      const data = store.load();
      data.autonomyPolicy = { ...policyPreset('trusted'), checks: { runner: 'local' } };
      if (optimistic) data.autonomyPolicy.acceptance.landing = 'optimistic';
      data.schema = 14;
      data.revision++;
      store.save(data);
    });
    await agent.dispatch({
      action: 'define-check',
      name: 'verify',
      executable: process.execPath,
      args: [
        '-e',
        "setTimeout(()=>process.exit(process.env.FORGE_CHECK_FULL==='1'&&require('fs').existsSync('bad.txt')?1:0),100)",
      ],
    });
    const lanes = [];
    for (let i = 0; i < count; i++) {
      const lane = (await agent.dispatch({ action: 'start', outcome: `Synthetic benchmark ${i}` })).result;
      writeFileSync(join(lane.path, breaking && i === 1 ? 'bad.txt' : `good${i}.txt`), `${i}\n`);
      await agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Benchmark input' });
      lanes.push(lane);
    }
    const start = performance.now();
    const receipts = await Promise.all(
      lanes.map(lane =>
        agent.dispatch({
          action: 'finish',
          operationId: randomUUID(),
          laneId: lane.laneId,
          message: 'Synthetic benchmark landing',
          accept: { channel: 'main' },
          maxRetries: 12,
        }),
      ),
    );
    // land-ready can resume a waiting batch; time includes draining every submitted entry.
    for (let round = 0; round < count && receipts.some(receipt => !receipt.result.complete); round++)
      await agent.dispatch({ action: 'land-ready' });
    const toMainMs = performance.now() - start;
    const landed = store.load().channelMoves.filter(move => move.status === 'accepted').length;
    if (!landed) throw new Error('Benchmark did not land source');
    await drainPostAccept(store);
    const toGreenMs = performance.now() - start;
    const data = store.load();
    const head = data.channelMoves.at(-1).head;
    const hasBad = new NativeSource(root).state(head).files.some(file => file.path === 'bad.txt');
    if (breaking && hasBad) throw new Error('Recovery did not restore green');
    console.log(
      JSON.stringify({
        count,
        mode: optimistic ? 'optimistic' : 'batched',
        breaking,
        toMainMs: Math.round(toMainMs),
        toGreenMs: Math.round(toGreenMs),
        recoveryMs: Math.round(toGreenMs - toMainMs),
        moves: data.channelMoves.length,
        runs: data.runs.length,
      }),
    );
  } finally {
    if (queueBefore === undefined) delete process.env.FORGE_CHECK_QUEUE_DIR;
    else process.env.FORGE_CHECK_QUEUE_DIR = queueBefore;
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}
for (const count of [4, 8]) for (const optimistic of [false, true]) await measure(count, optimistic);
await measure(4, true, true);
