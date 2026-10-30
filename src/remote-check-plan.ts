import { semanticCheckCommand } from './semantic-check-command.js';
// SPDX-License-Identifier: Apache-2.0
import { runDetails } from './work-detail-store.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { latestCheckCoverage } from './check-coverage.js';
import { digest } from './hash.js';
import { NativeSource } from './native-source.js';
import { writeCheckScope } from './work-check-scope.js';
import { actionsCheckRuntime, balanceShards } from './check-backend.js';
import type { WorkStore } from './work-store.js';
import type { CheckRun } from './work-types.js';
import { partitionTests, timingDurations } from '../scripts/test-shards.mjs';
import { readTimingHistory } from '../scripts/test-timings-file.mjs';

// Historical modal-* filenames are shared Actions receipt formats; retain them for replay.
export async function remoteCheckPlan(
  store: WorkStore,
  run: CheckRun,
  path: string,
  shards?: number,
  runtime = actionsCheckRuntime(undefined),
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
  const { standardSelection, selectTests } = await import('../scripts/test-impact.mjs');
  let comparison: { paths?: string[]; base?: string; semanticTests?: string[] } = {};
  try {
    const observed = JSON.parse(readFileSync(writeCheckScope(store, run, path), 'utf8'));
    // Match forge-check's pinnedComparison contract; view-base comparisons are not scoped.
    if (observed.comparison === 'main') comparison = observed;
  } catch {
    /* Full selection on missing ancestry. */
  }
  const selection =
    run.checkSelection?.scope === 'partial'
      ? runDetails(store, run).checkSelection!
      : standard
        ? standardSelection({
            files,
            coverage: comparison.base ? latestCheckCoverage(store, comparison.base) : undefined,
            ...comparison,
            ...(run.mainCheck ? { mainCheck: run.mainCheck } : {}),
            ...(run.interaction !== undefined ? { interaction: run.interaction } : {}),
            env: run.environment.env,
          })
        : { scope: 'full', reason: 'Exact configured command', tests: [] as string[] };
  if (run.checkSelection?.scope === 'partial' && selection.tests.some(path => !files.has(path)))
    throw new Error('An explicit test file is absent from the pinned source.');
  const durations = timingDurations(readTimingHistory(join(store.directory, 'test-timings.json')));
  const lockfile = digest(files.get('package-lock.json') ?? '');
  const impact = comparison.paths
    ? comparison.paths.length
      ? selectTests({ files, paths: comparison.paths })
      : { scope: 'none', tests: [] as string[] }
    : undefined;
  const retryFiles =
    impact && impact.scope !== 'full'
      ? selection.tests.filter(file => !comparison.paths!.includes(file) && !impact.tests.includes(file))
      : [];
  const pins = {
    retryFiles,
    runId: run.id,
    viewId: run.viewId,
    head: run.head,
    definition: run.check.definition,
    selection,
    lockfile,
    runtime,
    groups: standard
      ? shards
        ? partitionTests(selection.tests, shards, durations)
        : balanceShards(selection.tests, durations, selection.scope === 'full')
      : [],
    standard,
    artifacts: run.check.artifactPaths ?? [],
    interaction: run.interaction !== undefined,
    command: semanticCheckCommand(
      [
        run.check.executable === process.execPath || /(?:^|\/)node$/.test(run.check.executable)
          ? 'node'
          : run.check.executable,
        ...run.check.args,
      ],
      standard ? undefined : store.select('views', run.viewId)?.semanticPlan,
    ),
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
export type RemoteCheckPlan = NonNullable<Awaited<ReturnType<typeof remoteCheckPlan>>> & {
  /** Retained pre-retirement Actions plans included this pin. */
  costSafetyMargin?: number;
};

/** Recompute the retained recipe, including exact View and shard membership. */
export function validateRemoteCheckPlan(plan: RemoteCheckPlan, run: CheckRun) {
  const {
    retryFiles,
    runId,
    viewId,
    head,
    definition,
    selection,
    lockfile,
    runtime,
    costSafetyMargin,
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
        ...(retryFiles !== undefined ? { retryFiles } : {}),
        runId,
        viewId,
        head,
        definition,
        selection,
        lockfile,
        runtime,
        ...(costSafetyMargin !== undefined ? { costSafetyMargin } : {}),
        groups,
        standard,
        artifacts,
        interaction,
        command,
      }),
    ) !== plan.pin
  )
    throw new Error('Retained remote source, Candidate or plan digest changed.');
}
