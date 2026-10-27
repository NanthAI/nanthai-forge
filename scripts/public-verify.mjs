// SPDX-License-Identifier: Apache-2.0
// Full public-mirror checks reuse Forge's selection, partition and Actions executor.
import { benchmarkPlan } from './bench-landing-shard.mjs';
import { runActionsCheck } from './github-actions-check.mjs';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function publicVerify(shard, count, execute) {
  if (!/^[1-9]\d*$/.test(count) || !Number.isSafeInteger(Number(count)))
    throw new Error('Expected a positive integer shard count.');
  const plan = benchmarkPlan(Number(count), {});
  if (shard !== 'static' && (!/^(0|[1-9]\d*)$/.test(shard) || !plan.groups[Number(shard)]))
    throw new Error('Unselected public verification shard.');
  const path = join(process.env.RUNNER_TEMP, 'public-verify-plan.json');
  writeFileSync(path, JSON.stringify(plan));
  process.env.FORGE_ACTIONS_PLAN = path;
  process.env.FORGE_ACTIONS_SHARD = shard;
  console.log(
    `Public verification: ${plan.selection.tests.length} files; ${plan.groups.length} shards; running ${shard}`,
  );
  // The static job supplies build artifacts; test jobs only run their selected files.
  runActionsCheck(execute, { install: false, build: false });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  publicVerify(...process.argv.slice(2));
