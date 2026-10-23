// SPDX-License-Identifier: Apache-2.0
// Same scoped selection, static contracts and explicit shard membership as Forge Actions.
import { pinnedComparison, standardSelection, sourceFiles } from './test-impact.mjs';
import { runActionsCheck } from './github-actions-check.mjs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { partitionTests, timingDurations } from './test-shards.mjs';
import { readTimingHistory } from './test-timings-file.mjs';
export function benchmarkPlan(
  count,
  comparison = pinnedComparison(),
  files = sourceFiles(),
  durations = timingDurations(readTimingHistory()),
) {
  const selection = standardSelection({ ...comparison, files });
  const groups = partitionTests(selection.tests, Number(count), durations);
  return { standard: true, selection, groups, interaction: comparison?.interaction !== undefined };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [index, count] = process.argv.slice(2);
  const plan = benchmarkPlan(count);
  if (index !== 'static' && !plan.groups[Number(index)]) process.exit(0);
  const path = join(process.env.RUNNER_TEMP, 'bench-forge-check-plan.json');
  writeFileSync(path, JSON.stringify(plan));
  process.env.FORGE_ACTIONS_PLAN = path;
  process.env.FORGE_ACTIONS_SHARD = index;
  runActionsCheck(undefined, { install: false });
}
