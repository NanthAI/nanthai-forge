// SPDX-License-Identifier: Apache-2.0
import { mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HostedCheckRun } from './hosted-check.js';
import { standardTestPath } from './intent-test-contract.js';
import { checkPin } from './hosted-check.js';
import { semanticTests } from './intent-semantic-conflict.js';
import { guardedSelection, standardSelection } from '../scripts/test-impact.mjs';
import { describeShardPlan, timedShards } from '../scripts/test-shards.mjs';
import { hostedActionsRecipeSchema } from './hosted-actions.js';
import { actionsDeclaration } from './actions-toolchains.js';
import {
  ACTIONS_WORKFLOW_OUTDATED,
  actionsToolUnsupported,
  declaredStepsInstalled,
  hostedUnsupportedTools,
  hostedDepsCache,
  hostedToolchains,
} from './actions-toolchains-hosted.js';
import { ActionsJobClient } from './hosted-actions-job-client.js';
import {
  actionsJobCalls,
  actionsPoolCapability,
  actionsToolchainsCapability,
} from './hosted-actions-capabilities.js';
import { planPool, poolArm, poolUnits } from '../scripts/shard-pool.mjs';
import { poolClaimsSchema, type PoolClaim } from './hosted-actions-pool.js';
import { invariant } from './errors.js';
import { materializeActionsSource } from './hosted-actions-job-source.js';
import { scopedRecheckBase, scopedRecheckPairs } from './scoped-recheck-policy.js';
import { batchScopedRecheckSelection, scopedRecheckSelection } from './scoped-recheck.js';
import type { NativeState } from './native-state-format.js';
import { refreshSourcePack } from './source-pack.js';
import { refreshActionsSourcePack } from './hosted-actions-job-pack.js';
import { testedDocs } from './tested-docs.js';
import { checkedPackagePlacement } from './package-placement-pin.js';
import { declaredTestedDocs, docsOnlyChange } from './docs-paths.js';
import { selectionFallback } from './fallback-reasons.js';
import { resolveTestRunner } from './project-test-runner.js';
import { scanSecretPaths, SECRET_SCAN_ALLOW_FILE } from './secret-scan.js';
import { isStandardForgeCheck } from './standard-check.js';
import { commandSelection, commandShardCount, commandShardGroups } from './check-command-scope.js';
import { lockfileDigest } from './project-lockfile.js';
import { graphShareFor, isGraphFirstGate } from './graph-first-check.js';
/** The base (main) allow file's bytes. Usually cached already (unchanged, or from the base
 * pack); otherwise one small object read, only when the base has the file. Unreadable
 * means no allow entries: findings then fail, never pass. */
async function baseAllowBytes(source: Awaited<ReturnType<typeof materializeActionsSource>>, cache: string) {
  const file = source.base.files.find(item => item.path === SECRET_SCAN_ALLOW_FILE);
  if (!file || file.mode === 'symlink') return undefined;
  const path = join(cache, file.blob);
  try {
    if (!existsSync(path)) {
      await source.connection.resolve([file.blob]);
      await source.connection.prepareRecipes([file.blob]);
      await source.reader.resolveMany([file.blob]);
    }
    return readFileSync(path);
  } catch {
    console.log('secret scan: the base allow file is unreadable; no allow entries apply');
    return undefined;
  }
}
/** Keep only paths/hashes in memory. Import analysis reads one source file at a time. */
class SourceFiles extends Map<string, string> {
  constructor(
    private blobs: Map<string, string>,
    private cache: string,
  ) {
    super([...blobs.keys()].map(path => [path, '']));
  }
  override get(path: string) {
    const hash = this.blobs.get(path);
    return hash ? readFileSync(join(this.cache, hash), 'utf8') : undefined;
  }
  override *entries(): MapIterator<[string, string]> {
    for (const path of this.keys()) yield [path, this.get(path)!];
  }
  override [Symbol.iterator]() {
    return this.entries();
  }
  override *values(): MapIterator<string> {
    for (const path of this.keys()) yield this.get(path)!;
  }
}
export async function prepareActionsJob(
  client: ActionsJobClient,
  directory: string,
  cache: string,
  capacity?: { activeChecks: number; jobCap: number },
  /** The runner repository's installed forge-check.yml; undefined skips the step check. */
  workflow?: string,
) {
  console.log('Actions source: preparing pinned Candidate');
  // Fixed-cost phases of this step (Issue ca8a2ca4), printed once: durations only, no values.
  const phases: Record<string, number> = {};
  let mark = performance.now();
  const lap = (phase: string) => {
    const now = performance.now();
    phases[phase] = Math.round(now - mark);
    mark = now;
  };
  const run = await client.session(true);
  lap('sessionMs');
  invariant(run.configuration.provider === 'github-actions', 'RUNNER_UNAVAILABLE', 'Select Actions.');
  await mkdir(directory, { recursive: true });
  await mkdir(cache, { recursive: true });
  const source = await materializeActionsSource(client, directory, cache);
  lap('sourceMs');
  const { state, base, checkedBase, recheckPairs } = source;
  const inventory = new Map(state.files.map(file => [file.path, file]));
  const paths = changedPaths(base, state);
  const standard = isStandardForgeCheck(run.check);
  const files = new SourceFiles(new Map(state.files.map(file => [file.path, file.blob])), cache);
  const selected = actionsGateSelection(
    run,
    paths,
    files,
    standard,
    checkedBase ? changedPaths(checkedBase, base) : null,
    // Per cohort basis: its checked change, and everything in this Candidate that differs from it.
    recheckPairs?.map(pair => ({
      lanePaths: changedPaths(pair.base, pair.checked),
      mainPaths: changedPaths(pair.checked, state),
    })) ?? null,
  );
  // Markdown that tests or scripts read: a clean merge of any other Markdown can
  // land on its first check (Issue 7fe54c7c). Absent means every Markdown is tested.
  // An opaque command has no Forge selector: only its declared docs paths say which Markdown is untested.
  const docs = standard
    ? testedDocs(files.keys(), path => files.get(path))
    : declaredTestedDocs(run.check.docsPaths, files.keys());
  // Landing secret scan (src/secret-scan.ts): changed paths only, from bytes already cached.
  // Allow entries come from the composition base (main), never from the Candidate (R-01).
  const scanStarted = performance.now();
  const baseAllow = await baseAllowBytes(source, cache);
  const secrets = scanSecretPaths(
    paths,
    path => {
      const file = inventory.get(path);
      return file && file.mode !== 'symlink' ? readFileSync(join(cache, file.blob)) : undefined;
    },
    { baseAllow },
  );
  console.log(
    `secret scan: ${secrets.scannedFiles} changed files in ${Math.round(performance.now() - scanStarted)} ms; ${secrets.findings.length + secrets.more} found, ${secrets.allowed} allowed from main` +
      (secrets.allowChanges
        ? `; ${secrets.allowChanges.entries.length + secrets.allowChanges.more} allow entries added or edited`
        : ''),
  );
  const selection = {
    scope: selected.scope,
    reason: selected.reason,
    tests: selected.tests,
    ...('fallback' in selected && selected.fallback ? { fallback: selected.fallback } : {}),
    ...(docs ? { testedDocs: docs } : {}),
    // The checked head's manifest package graph: the first-check proof places in-package manifests by it.
    ...checkedPackagePlacement(files.keys(), path => files.get(path)),
    // Any other command reads this as its changed-paths file (FORGE_CHECK_CHANGES).
    ...('changes' in selected ? { changes: selected.changes } : {}),
    // A package-graph first check's minority share, recorded on the run (src/graph-first-check.ts).
    ...('graph' in selected && selected.graph ? { graph: selected.graph } : {}),
    // A Candidate-decided refusal (src/hosted-actions-job-source.ts): every job fails with its code
    // before project code runs. Notes are lines every job prints into the check output.
    ...(source.planError ? { planError: source.planError } : {}),
    ...(source.notes.length ? { notes: source.notes } : {}),
    // Pinned in the plan so the static job fails on it. Value-free: path, line, kind, fingerprint.
    ...(secrets.findings.length || secrets.allowed || secrets.allowChanges
      ? {
          secretScan: {
            findings: secrets.findings,
            more: secrets.more,
            allowed: secrets.allowed,
            ...(secrets.selfAllowed ? { selfAllowed: secrets.selfAllowed } : {}),
            ...(secrets.allowChanges ? { allowChanges: secrets.allowChanges } : {}),
          },
        }
      : {}),
    ...(run.gate
      ? {
          gate: {
            ...run.gate,
            effective: selected.scope === 'full' ? 'full' : selected.scope === 'docs' ? 'docs' : 'contract',
          },
        }
      : {}),
  };
  // A docs scope shards only the tests that read a changed document (none for a document no test reads).
  const budget = {
    concurrencyBudget: run.configuration.concurrencyBudget ?? 12,
    callsPerJob: actionsJobCalls(client.capabilities),
  };
  // Another command shards only through its declared shard interface (FORGE_CHECK_SHARD);
  // a docs-scoped run of it runs no command, so it has no shards.
  const groups = !standard
    ? selection.scope === 'docs'
      ? []
      : commandShardGroups(commandShardCount(run.check, { ...budget, jobCap: capacity?.jobCap }))
    : selection.scope !== 'docs' || selection.tests.length
      ? timedShards(selection.tests, client.timings, { ...budget, ...capacity })
      : [];
  if (capacity)
    console.log(
      `Actions capacity: ${capacity.activeChecks} active checks, ${capacity.jobCap} slots; ${groups.length} test shards`,
    );
  if (groups.length)
    console.log(
      standard
        ? describeShardPlan(groups, client.timings)
        : `Command shards: ${groups.length} (declared ${run.check.selection?.shards})`,
    );
  // Shard pool (scripts/shard-pool.mjs): only servers that sign claims receive one.
  const poolMode = process.env.FORGE_ACTIONS_POOL_MODE;
  const pool =
    standard &&
    groups.length >= 2 &&
    client.capabilities.includes(actionsPoolCapability) &&
    poolArm(poolMode, run.id)
      ? planPool(groups, client.timings)
      : undefined;
  if (standard && groups.length >= 2)
    console.log(
      pool
        ? `Shard pool: on${poolMode === 'ab' ? ' (ab arm B)' : ''}; ${poolUnits(groups, pool).length} units`
        : `Shard pool: off${poolMode === 'ab' && client.capabilities.includes(actionsPoolCapability) ? ' (ab arm A)' : ''}`,
    );
  const declaration = actionsDeclaration(run.check);
  // A server that cannot pin the declaration would plan the check without its toolchains.
  invariant(
    !declaration || client.capabilities.includes(actionsToolchainsCapability),
    'RUNNER_UNAVAILABLE',
    'This check declares toolchains or cache; the server does not advertise checks.toolchains yet.',
  );
  const pins = {
    head: run.request.expectedHead,
    definition: run.check.definition,
    selection,
    groups,
    ...(pool ? { pool } : {}),
    standard,
    interaction: false,
    command: [standard ? 'node' : run.check.executable, ...run.check.args],
    // Declared toolchains and cache: the workflow's setup steps read them from this pinned recipe.
    ...(declaration ? { actions: declaration } : {}),
  };
  const recipe = hostedActionsRecipeSchema.parse({ pin: checkPin(pins), ...pins });
  invariant(
    !recipe.actions || declaredStepsInstalled(workflow, recipe.actions),
    'ACTIONS_WORKFLOW_OUTDATED',
    ACTIONS_WORKFLOW_OUTDATED,
  );
  const unsupported = hostedUnsupportedTools(recipe.actions);
  invariant(!unsupported.length, 'ACTIONS_TOOL_UNSUPPORTED', actionsToolUnsupported(unsupported));
  lap('selectMs');
  // Decided before the plan call: the server reads the required jobs' conclusions early, so a
  // pass never waits for this optional job (friction 0064c3b2).
  const packRefresh =
    client.capabilities.includes('sourcePack') &&
    refreshSourcePack(
      source.packed ? client.sourcePack : null,
      source.deltaFiles,
      source.deltaBytes,
      source.totalBytes,
    );
  const planned = (await client.call({
    kind: 'plan',
    plan: { recipe, lockfile: lockfileDigest(state.files) },
    ...(packRefresh ? { packRefresh: true as const } : {}),
  })) as typeof run | { run: typeof run; claims: unknown };
  let claims: PoolClaim[] | null = null;
  if (recipe.pool) {
    const reply = planned as { run: typeof run; claims: unknown };
    client.run = reply.run;
    // Unusable targets never fail the check: shards then run their static groups.
    const parsed = poolClaimsSchema.safeParse(reply.claims);
    claims =
      parsed.success && parsed.data.length === poolUnits(groups, recipe.pool).length ? parsed.data : null;
    if (!claims) console.log('Shard pool: claim targets unavailable; shards run their static groups');
  } else client.run = planned as typeof run;
  lap('planCallMs');
  console.log(`plan: phases ${JSON.stringify(phases)}`);
  return {
    packRefresh: {
      refresh: packRefresh,
      state,
      base,
      packed: source.packed,
      deltaFiles: source.deltaFiles,
      deltaBytes: source.deltaBytes,
      totalBytes: source.totalBytes,
      sourcePack: client.capabilities.includes('sourcePack') ? client.sourcePack : null,
    },
    refreshSourcePack: () => refreshActionsSourcePack(client, source, cache),
    run: client.run,
    claims,
    stateBytes: source.stateBytes,
    recipe,
    // The static job is always an execution, including opaque commands and docs.
    // With no test shards it can use the planning runner and its verified source.
    singleShard: groups.length === 0 ? 'static' : '',
    // Workflow outputs (`toolchains`, `deps_cache`); `{}` when nothing is declared.
    toolchains: hostedToolchains(recipe.actions),
    depsCache: hostedDepsCache(recipe.actions, {
      projectId: run.projectId,
      files: state.files,
      save: run.gate?.mode === 'audit',
      os: process.env.RUNNER_OS,
      arch: process.env.RUNNER_ARCH,
    }),
    matrix: groups.length === 0 ? [] : [...groups.map((_, index) => String(index)), 'static'],
  };
}

const changedPaths = (before: NativeState, after: NativeState) => {
  const a = new Map(before.files.map(file => [file.path, file])),
    b = new Map(after.files.map(file => [file.path, file]));
  return [...new Set([...b.keys(), ...a.keys()])].filter(
    path => checkPin(b.get(path) ?? null) !== checkPin(a.get(path) ?? null),
  );
};
type RecheckMembers = { lanePaths: string[]; mainPaths: string[] }[] | null;
/** Gate metadata is sent only in response to a server-stamped run (skew handshake).
 * `mainPaths` is the main delta since a scoped recheck's checked base; `members` a cohort
 * recheck's per-basis sides (Issue 28f08555), null when a basis State is unavailable. */
export function actionsGateSelection(
  run: HostedCheckRun,
  paths: string[],
  files: Map<string, string>,
  standard: boolean,
  mainPaths: string[] | null = null,
  members: RecheckMembers = null,
) {
  const raw = gateSelection(run, paths, files, standard, mainPaths, members);
  // Gate probes, contract unions and rechecks can select nothing; that must never pass.
  const selected = standard ? guardedSelection(raw, { files, paths }) : raw;
  // Why the command could not be narrowed or skipped, pinned with the selection (7c2e69e1).
  const fallback = selectionFallback({
    standard,
    gate: run.gate,
    docsPaths: run.check?.docsPaths,
    paths,
    mainPaths,
    members,
    selected,
    // Intent union tests under another command run with the project's own test runner.
    testRunner: () =>
      !standard && semanticTests(run.semanticPlan).length
        ? resolveTestRunner(files.get('package.json'), () => files.keys()).status
        : undefined,
  });
  return fallback ? { ...selected, fallback } : selected;
}
function gateSelection(
  run: HostedCheckRun,
  paths: string[],
  files: Map<string, string>,
  standard: boolean,
  mainPaths: string[] | null,
  members: RecheckMembers,
) {
  const gate = run.gate;
  const union = semanticTests(run.semanticPlan);
  if (!standard) {
    // Opt-in `docsPaths` (like paths-ignore): a change that touches only those paths runs no command.
    // Audit and probe runs and composed Intent contract tests always keep the whole command.
    if (
      docsOnlyChange(run.check?.docsPaths, paths) &&
      gate?.mode !== 'audit' &&
      gate?.mode !== 'probe' &&
      !union.length
    )
      return {
        scope: 'docs',
        reason: 'Every changed path matches the check’s docs paths',
        tests: [] as string[],
      };
    // Any other command gets the changed paths; it scopes only when its check declares so.
    return commandSelection(
      run,
      paths,
      files,
      scopedRecheckBase(gate) ? mainPaths : null,
      changed => graphShareFor(files, changed, run.check),
      members,
    );
  }
  const forceFull = gate?.mode === 'audit' || (gate?.mode === 'full' && union.length > 0);
  // Forge's own recipe keeps full first checks (Issue 5562167f): a graph-first gate reads as full here.
  const env = forceFull
    ? { FORGE_CHECK_FULL: '1' }
    : gate?.mode === 'full' || isGraphFirstGate(gate)
      ? {}
      : gate
        ? { FORGE_CHECK_SCOPED: '1' }
        : {};
  if (gate?.mode === 'probe') {
    const tests = [...new Set(gate.tests ?? [])].sort();
    invariant(
      tests.every(test => standardTestPath(test) && files.has(test)),
      'EVIDENCE_CHANGED',
      'A probe test is absent from the exact Candidate.',
    );
    return { scope: 'scoped', reason: gate.reason ?? 'Failed-file probe', tests };
  }
  if (scopedRecheckBase(gate)) {
    if (mainPaths)
      return scopedRecheckSelection({ lanePaths: paths, mainPaths, files, semanticTests: union });
    const selected = standardSelection({
      paths,
      files,
      semanticTests: union,
      env: { FORGE_CHECK_FULL: '1' },
    });
    return { ...selected, reason: `Scoped recheck base unavailable; ${selected.reason}` };
  }
  if (scopedRecheckPairs(gate)) {
    if (members) return batchScopedRecheckSelection({ members, files, semanticTests: union });
    const selected = standardSelection({
      paths,
      files,
      semanticTests: union,
      env: { FORGE_CHECK_FULL: '1' },
    });
    return { ...selected, reason: `Scoped recheck base unavailable; ${selected.reason}` };
  }
  const selected = standardSelection({ paths, files, semanticTests: union, env });
  if (!gate || gate.mode !== 'contract' || selected.scope === 'full' || selected.scope === 'docs')
    return selected;
  const tests = [
    ...new Set([
      ...(gate.tests ?? []),
      ...union,
      ...paths.filter(path => standardTestPath(path) && files.has(path)),
    ]),
  ].sort();
  invariant(
    tests.every(test => standardTestPath(test) && files.has(test)),
    'EVIDENCE_CHANGED',
    'A gate test is absent from the exact Candidate.',
  );
  return { scope: 'scoped', reason: gate.reason ?? `${gate.mode} gate`, tests };
}
