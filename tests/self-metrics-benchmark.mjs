// SPDX-License-Identifier: Apache-2.0
// Paired scratch finish benchmark. Setup/cleanup are outside the measured intervals.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { initNative } from '../dist/native-work.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { selfMetricsTestHooks } from '../dist/self-metrics-journal.js';
import { trustAgents } from './autonomy-fixture.mjs';
import { cleanupOwner } from './owner-cleanup.mjs';
const pairs = [];
const sourceFiles = process.env.FORGE_METRICS_BENCH_SOURCE_FILES === '1' ? 1 : 257;
const oldQueue = process.env.FORGE_CHECK_QUEUE_DIR;
try {
  for (let pair = 0; pair < 23; pair++) {
    const root = mkdtempSync(join(tmpdir(), 'forge-m1-bench-pair-'));
    process.env.FORGE_CHECK_QUEUE_DIR = join(root, '.forge', 'benchmark-queue');
    selfMetricsTestHooks.disabled = false;
    writeFileSync(join(root, 'file.txt'), 'initial\n');
    for (let file = 0; file < sourceFiles - 1; file++)
      writeFileSync(
        join(root, `source-${file}.ts`),
        `export const value = ${file};\n/*${'x'.repeat(16 * 1024)}*/\n`,
      );
    initNative(root);
    trustAgents(root);
    const agent = new AgentWorkflow(root);
    try {
      const check = (
        await agent.dispatch({
          action: 'define-check',
          name: 'verify',
          executable: process.execPath,
          args: ['-e', 'process.exit(0)'],
        })
      ).result;
      const lanes = [];
      for (let i = 0; i < 2; i++) {
        const lane = (
          await agent.dispatch({
            action: 'start',
            operationId: randomUUID(),
            outcome: 'scratch metric benchmark',
          })
        ).result;
        writeFileSync(join(lane.path, `file-${i}.txt`), `save ${i}\n`);
        lanes.push(lane);
      }
      const result = {};
      for (const [index, mode] of (pair % 2 ? ['after', 'before'] : ['before', 'after']).entries()) {
        const lane = lanes[index];
        selfMetricsTestHooks.disabled = mode === 'before';
        const start = performance.now();
        const receipt = await agent.dispatch({
          action: 'finish',
          operationId: randomUUID(),
          laneId: lane.laneId,
          expectedHead: lane.head,
          message: 'scratch',
          accept: true,
          checkId: check.checkId,
          expectedDefinition: check.definition,
        });
        const ms = performance.now() - start;
        if (!receipt.result.complete) throw Error('finish did not complete');
        result[mode] = ms;
      }
      if (pair >= 3) pairs.push(result);
    } finally {
      selfMetricsTestHooks.disabled = false;
      await cleanupOwner(root);
    }
  }
  const p50 = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const beforeP50Ms = p50(pairs.map(p => p.before)),
    afterP50Ms = p50(pairs.map(p => p.after));
  console.log(
    JSON.stringify({
      pairs,
      sourceFiles,
      syntheticSourceBytes: (sourceFiles - 1) * 16 * 1024,
      beforeP50Ms,
      afterP50Ms,
      changePercent: 100 * (afterP50Ms / beforeP50Ms - 1),
      pairedMedianChangePercent: p50(pairs.map(p => 100 * (p.after / p.before - 1))),
      samplesPerArm: pairs.length,
      node: process.version,
      method: 'same runtime, isolated check queue, alternating paired order, 3 warmup pairs',
    }),
  );
} finally {
  selfMetricsTestHooks.disabled = false;
  if (oldQueue === undefined) delete process.env.FORGE_CHECK_QUEUE_DIR;
  else process.env.FORGE_CHECK_QUEUE_DIR = oldQueue;
}
