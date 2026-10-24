// SPDX-License-Identifier: Apache-2.0
import { replayLanding, syntheticWorkloads } from '../dist/landing-replay.js';
const results = [];
for (const workload of syntheticWorkloads())
  for (const planner of ['serial', 'train']) results.push(await replayLanding(workload, planner));
console.log(
  JSON.stringify(
    {
      schema: 1,
      basis:
        'Deterministic synthetic reference planners; no provider or usage API calls. Fake durations are model inputs, not live speedup measurements.',
      inputs: {
        runner: 'blacksmith-4vcpu-ubuntu-2404',
        estimatedRateUsdPerJobMinute: 0.008,
        staticJobSeconds: 120,
        testShards: 4,
        shardJobSeconds: 300,
        collectionWindowMs: 0,
        trainBatchSize: 8,
        trainConcurrency: 4,
        previewControlMs: 10,
        previewControls: 'synthetic local controls with parallel logical completion',
        infrastructure:
          'modeled receipt adoption/rejection/replacement; no real controller or provider execution',
      },
      results,
    },
    null,
    2,
  ),
);
