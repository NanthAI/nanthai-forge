// SPDX-License-Identifier: Apache-2.0
// Same scoped selection, static contracts and explicit shard membership as Forge Actions.
import { pinnedComparison, standardSelection, sourceFiles } from './test-impact.mjs';
import { runActionsCheck } from './github-actions-check.mjs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
export function benchmarkPlan(count, comparison = pinnedComparison(), files = sourceFiles()) {
  const selection = standardSelection({ ...comparison, files });
  // modalPlan uses the selection order directly when checks.shards is explicit.
  const groups = Array.from({ length: Math.min(Number(count), selection.tests.length) }, (_, shard) =>
    selection.tests.filter((_, position) => position % Number(count) === shard),
  );
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
