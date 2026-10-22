// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { latestCheckCoverage } from './check-coverage.js';
import { digest } from './hash.js';
import { MODAL_COST_SAFETY_MARGIN } from './modal-cost.js';
import { NativeSource } from './native-source.js';
import { writeCheckScope } from './work-check-scope.js';
import { balanceShards } from './check-backend.js';
import type { WorkStore } from './work-store.js';
import type { CheckRun } from './work-types.js';

export const modalRuntime =
  'node:24.19.0-trixie-slim;git;time;python3;modal-sdk:1.6.2;cpu:2;memory:4096;static-memory:8192;static-oom-retry:16384;static-workers:2;static-heap:3072;flake-retry:1;resume:1;cost:worker-runtime-margin-1;timeout:900';
export const modalBridge = fileURLToPath(new URL('../scripts/modal-check/runner.py', import.meta.url));
export async function modalPlan(
  store: WorkStore,
  run: CheckRun,
  path: string,
  shards?: number,
  runtime = modalRuntime,
) {
  const source = new NativeSource(store.root),
    state = source.state(run.head);
  // Snapshots with local credential/config files remain entirely on the owner.
  if (
    state.files.some(file =>
      file.path
        .split('/')
        .some(
          part =>
            ['.git', '.forge', 'node_modules', '.npmrc', '.modal.toml', '.netrc'].includes(part) ||
            (part.startsWith('.env') && part !== '.env.example'),
        ),
    )
  )
    return null;
  const standard =
    JSON.stringify(run.check.args) === JSON.stringify(['scripts/forge-check.mjs']) &&
    (run.check.executable === process.execPath || /(?:^|\/)node$/.test(run.check.executable));
  const files = new Map(state.files.map(file => [file.path, source.object(file.blob).toString('utf8')]));
  const { standardSelection } = await import('../scripts/test-impact.mjs');
  let comparison: { paths?: string[]; base?: string } = {};
  try {
    const observed = JSON.parse(readFileSync(writeCheckScope(store, run, path), 'utf8'));
    // Match forge-check's pinnedComparison contract; view-base comparisons are not scoped.
    if (observed.comparison === 'main') comparison = observed;
  } catch {
    /* Full selection on missing ancestry. */
  }
  const selection = standard
    ? standardSelection({
        files,
        coverage: comparison.base ? latestCheckCoverage(store, comparison.base) : undefined,
        ...comparison,
        ...(run.mainCheck ? { mainCheck: run.mainCheck } : {}),
        ...(run.interaction !== undefined ? { interaction: run.interaction } : {}),
        env: run.environment.env,
      })
    : { scope: 'full', reason: 'Exact configured command', tests: [] as string[] };
  let durations: Record<string, number> = {};
  try {
    durations = JSON.parse(readFileSync(join(store.directory, 'modal-durations.json'), 'utf8'));
  } catch {
    /* Equal weights until observed. */
  }
  const lockfile = digest(files.get('package-lock.json') ?? '');
  const pins = {
    runId: run.id,
    viewId: run.viewId,
    head: run.head,
    definition: run.check.definition,
    selection,
    lockfile,
    runtime,
    costSafetyMargin: MODAL_COST_SAFETY_MARGIN,
    groups: standard
      ? shards
        ? Array.from({ length: Math.min(shards, selection.tests.length) }, (_, index) =>
            selection.tests.filter((_, position) => position % shards === index),
          )
        : balanceShards(selection.tests, durations, selection.scope === 'full')
      : [],
    standard,
    artifacts: run.check.artifactPaths ?? [],
    interaction: run.interaction !== undefined,
    command: [
      run.check.executable === process.execPath || /(?:^|\/)node$/.test(run.check.executable)
        ? 'node'
        : run.check.executable,
      ...run.check.args,
    ],
  };
  const plan = {
    ...pins,
    pin: digest(JSON.stringify(pins)),
    source: join(path, 'modal-source'),
    output: path,
  };
  source.materialize(run.head, plan.source, false);
  writeFileSync(join(path, 'modal-state.json'), source.object(run.head), { mode: 0o600, flag: 'wx' });
  writeFileSync(join(path, 'modal-plan.json'), JSON.stringify(plan), { mode: 0o600, flag: 'wx' });
  writeFileSync(join(path, 'selection.json'), JSON.stringify(selection), { mode: 0o600 });
  return plan;
}
export type ModalPlan = NonNullable<Awaited<ReturnType<typeof modalPlan>>>;

/** Recompute the retained recipe, including exact View and shard membership. */
export function validateModalPlan(plan: ModalPlan, run: CheckRun) {
  const {
    runId,
    viewId,
    head,
    definition,
    selection,
    lockfile,
    runtime,
    costSafetyMargin: MODAL_COST_SAFETY_MARGIN,
    groups,
    standard,
    artifacts,
    interaction,
    command,
  } = plan;
  if (
    runId !== run.id ||
    viewId !== run.viewId ||
    head !== run.head ||
    definition !== run.check.definition ||
    plan.pin !== run.backend?.pin ||
    digest(
      JSON.stringify({
        runId,
        viewId,
        head,
        definition,
        selection,
        lockfile,
        runtime,
        costSafetyMargin: MODAL_COST_SAFETY_MARGIN,
        groups,
        standard,
        artifacts,
        interaction,
        command,
      }),
    ) !== plan.pin
  )
    throw new Error('Retained Modal source, Candidate or plan digest changed.');
}
