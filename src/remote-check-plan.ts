// SPDX-License-Identifier: Apache-2.0
import { semanticCheckCommand } from './semantic-check-command.js';
import { actionsDeclaration } from './actions-toolchains.js';
import { resolveTestRunner } from './project-test-runner.js';
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
import { isStandardForgeCheck } from './standard-check.js';
import { projectLockfile } from './project-lockfile.js';
import { scanSecretPaths } from './secret-scan.js';
import { LazySourceFiles } from './lazy-source-files.js';

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
  // Structural exclusions only: VCS/Forge metadata and dependency installs never leave the owner.
  if (
    state.files.some(file =>
      file.path.split('/').some(part => ['.git', '.forge', 'node_modules'].includes(part)),
    )
  )
    return null;
  // Credentials are judged by content (the landing secret scan), never by file name: a committed
  // `.npmrc` or `.env.test` without a secret exports. One blob is in memory at a time; the
  // base allow file is not trusted here, so a finding keeps the snapshot with the owner.
  const blobs = new Map(state.files.map(file => [file.path, file.blob]));
  const scan = scanSecretPaths(
    state.files.filter(file => file.mode !== 'symlink').map(file => file.path),
    path => source.object(blobs.get(path)!),
    { baseAllow: undefined },
  );
  if (scan.findings.length || scan.more) return null;
  const standard = isStandardForgeCheck(run.check, process.execPath);
  const files = new LazySourceFiles(blobs, blob => source.object(blob).toString('utf8'));
  const { standardSelection, guardedSelection, selectTests } = await import('../scripts/test-impact.mjs');
  let comparison: { paths?: string[]; base?: string; semanticTests?: string[] } = {};
  try {
    const observed = JSON.parse(readFileSync(writeCheckScope(store, run, path), 'utf8'));
    // Match forge-check's pinnedComparison contract; view-base comparisons are not scoped.
    if (observed.comparison === 'main') comparison = observed;
  } catch {
    /* Full selection on missing ancestry. */
  }
  const planned =
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
  // A selection that touches code but selects no test never reaches a passing plan.
  const selection = standard
    ? guardedSelection(planned, { files, paths: comparison.paths, interaction: run.interaction })
    : planned;
  if (run.checkSelection?.scope === 'partial' && selection.tests.some(path => !files.has(path)))
    throw new Error('An explicit test file is absent from the pinned source.');
  const durations = timingDurations(readTimingHistory(join(store.directory, 'test-timings.json')));
  const lockfile = digest(files.get(projectLockfile(path => files.has(path)) ?? '') ?? '');
  const impact = comparison.paths
    ? comparison.paths.length
      ? selectTests({ files, paths: comparison.paths })
      : { scope: 'none', tests: [] as string[] }
    : undefined;
  const retryFiles =
    impact && impact.scope !== 'full'
      ? selection.tests.filter(file => !comparison.paths!.includes(file) && !impact.tests.includes(file))
      : [];
  const declaration = actionsDeclaration(run.check);
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
      'node',
      [],
      standard
        ? undefined
        : resolveTestRunner(files.get('package.json'), () => files.keys(), {
            forgeJson: files.get('forge.json'),
          }),
    ),
    // Declared toolchains and cache become workflow steps, so the pin names them (absent: unchanged pin).
    ...(declaration ? { actions: declaration } : {}),
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
    actions,
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
        ...(actions !== undefined ? { actions } : {}),
      }),
    ) !== plan.pin ||
    JSON.stringify(actions ?? null) !== JSON.stringify(actionsDeclaration(run.check) ?? null)
  )
    throw new Error('Retained remote source, Candidate or plan digest changed.');
}
