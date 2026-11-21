// SPDX-License-Identifier: Apache-2.0
// Full public-mirror checks reuse Forge's selection, partition and Actions executor.
import { benchmarkPlan } from './bench-landing-shard.mjs';
import { runActionsCheck } from './github-actions-check.mjs';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { browserShard } from './browser-test-policy.mjs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function publicVerify(shard, count, execute) {
  if (!/^[1-9]\d*$/.test(count) || !Number.isSafeInteger(Number(count)))
    throw new Error('Expected a positive integer shard count.');
  const path = join(process.env.RUNNER_TEMP, 'public-verify-plan.json');
  const plan = shard === 'static' ? benchmarkPlan(Number(count), {}) : JSON.parse(readFileSync(path, 'utf8'));
  if (shard === 'static') {
    writeFileSync(path, JSON.stringify(plan));
    const browser = browserShard(plan.groups, plan.selection.browser);
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `browser_shard=${browser < 0 ? '' : browser}\n`);
  } else {
    if (plan.groups.length !== Number(count))
      throw new Error(`The public test plan has ${plan.groups.length} shards; the matrix expects ${count}.`);
    if (!/^(0|[1-9]\d*)$/.test(shard) || !plan.groups[Number(shard)])
      throw new Error('Unselected public verification shard.');
  }
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
