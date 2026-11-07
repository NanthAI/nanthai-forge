// SPDX-License-Identifier: Apache-2.0
import { mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HostedCheckRun } from './hosted-check.js';
import { contractTestPath } from './intent-test-contract.js';
import { checkPin } from './hosted-check.js';
import { semanticTests } from './intent-semantic-conflict.js';
import { digest } from './hash.js';
import { guardedSelection, standardSelection } from '../scripts/test-impact.mjs';
import { describeShardPlan, timedShards } from '../scripts/test-shards.mjs';
import { hostedActionsRecipeSchema } from './hosted-actions.js';
import { ActionsJobClient } from './hosted-actions-job-client.js';
import { actionsJobCalls, actionsPoolCapability } from './hosted-actions-capabilities.js';
import { planPool, poolArm, poolUnits } from '../scripts/shard-pool.mjs';
import { poolClaimsSchema, type PoolClaim } from './hosted-actions-pool.js';
import { invariant } from './errors.js';
import { materializeActionsSource } from './hosted-actions-job-source.js';
import { scopedRecheckBase } from './scoped-recheck-policy.js';
import { scopedRecheckSelection } from './scoped-recheck.js';
import type { NativeState } from './native-state-format.js';
import { refreshSourcePack } from './source-pack.js';
import { refreshActionsSourcePack } from './hosted-actions-job-pack.js';
import { testedDocs } from './tested-docs.js';
import { scanSecretPaths, SECRET_SCAN_ALLOW_FILE } from './secret-scan.js';
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
) {
  console.log('Actions source: preparing pinned Candidate');
  const run = await client.session(true);
  invariant(run.configuration.provider === 'github-actions', 'RUNNER_UNAVAILABLE', 'Select Actions.');
  await mkdir(directory, { recursive: true });
  await mkdir(cache, { recursive: true });
  const source = await materializeActionsSource(client, directory, cache);
  const { state, base, checkedBase } = source;
  const inventory = new Map(state.files.map(file => [file.path, file]));
  const paths = changedPaths(base, state);
  const standard =
    /(?:^|\/)node$/.test(run.check.executable) &&
    JSON.stringify(run.check.args) === '["scripts/forge-check.mjs"]';
  const files = new SourceFiles(new Map(state.files.map(file => [file.path, file.blob])), cache);
  const selected = actionsGateSelection(
    run,
    paths,
    files,
    standard,
    checkedBase ? changedPaths(checkedBase, base) : null,
  );
  // Markdown that tests or scripts read: a clean merge of any other Markdown can
  // land on its first check (Issue 7fe54c7c). Absent means every Markdown is tested.
  const docs = standard ? testedDocs(files.keys(), path => files.get(path)) : undefined;
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
    ...(docs ? { testedDocs: docs } : {}),
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
  const groups =
    standard && (selection.scope !== 'docs' || selection.tests.length)
      ? timedShards(selection.tests, client.timings, {
          concurrencyBudget: run.configuration.concurrencyBudget ?? 12,
          callsPerJob: actionsJobCalls(client.capabilities),
          ...capacity,
        })
      : [];
  if (capacity)
    console.log(
      `Actions capacity: ${capacity.activeChecks} active checks, ${capacity.jobCap} slots; ${groups.length} test shards`,
    );
  if (groups.length) console.log(describeShardPlan(groups, client.timings));
  // Shard pool (scripts/shard-pool.mjs): only servers that sign claims receive one.
  const poolMode = process.env.FORGE_ACTIONS_POOL_MODE;
  const pool =
    groups.length >= 2 && client.capabilities.includes(actionsPoolCapability) && poolArm(poolMode, run.id)
      ? planPool(groups, client.timings)
      : undefined;
  if (groups.length >= 2)
    console.log(
      pool
        ? `Shard pool: on${poolMode === 'ab' ? ' (ab arm B)' : ''}; ${poolUnits(groups, pool).length} units`
        : `Shard pool: off${poolMode === 'ab' && client.capabilities.includes(actionsPoolCapability) ? ' (ab arm A)' : ''}`,
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
  };
  const recipe = hostedActionsRecipeSchema.parse({ pin: checkPin(pins), ...pins });
  const lock = inventory.get('package-lock.json');
  const planned = (await client.call({
    kind: 'plan',
    plan: { recipe, lockfile: digest(lock ? readFileSync(join(cache, lock.blob)) : Buffer.alloc(0)) },
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
  return {
    packRefresh: {
      refresh:
        client.capabilities.includes('sourcePack') &&
        refreshSourcePack(
          source.packed ? client.sourcePack : null,
          source.deltaFiles,
          source.deltaBytes,
          source.totalBytes,
        ),
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
/** Gate metadata is sent only in response to a server-stamped run (skew handshake).
 * `mainPaths` is the main delta since a scoped recheck's checked base. */
export function actionsGateSelection(
  run: HostedCheckRun,
  paths: string[],
  files: Map<string, string>,
  standard: boolean,
  mainPaths: string[] | null = null,
) {
  const selected = gateSelection(run, paths, files, standard, mainPaths);
  // Gate probes, contract unions and rechecks can select nothing; that must never pass.
  return standard ? guardedSelection(selected, { files, paths }) : selected;
}
function gateSelection(
  run: HostedCheckRun,
  paths: string[],
  files: Map<string, string>,
  standard: boolean,
  mainPaths: string[] | null,
) {
  if (!standard) return { scope: 'full', reason: 'Exact configured command', tests: [] as string[] };
  const gate = run.gate;
  const union = semanticTests(run.semanticPlan);
  const forceFull = gate?.mode === 'audit' || (gate?.mode === 'full' && union.length > 0);
  const env = forceFull
    ? { FORGE_CHECK_FULL: '1' }
    : gate?.mode === 'full'
      ? {}
      : gate
        ? { FORGE_CHECK_SCOPED: '1' }
        : {};
  if (gate?.mode === 'probe') {
    const tests = [...new Set(gate.tests ?? [])].sort();
    invariant(
      tests.every(test => contractTestPath.safeParse(test).success && files.has(test)),
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
  const selected = standardSelection({ paths, files, semanticTests: union, env });
  if (!gate || gate.mode !== 'contract' || selected.scope === 'full' || selected.scope === 'docs')
    return selected;
  const tests = [
    ...new Set([
      ...(gate.tests ?? []),
      ...union,
      ...paths.filter(path => contractTestPath.safeParse(path).success && files.has(path)),
    ]),
  ].sort();
  invariant(
    tests.every(test => contractTestPath.safeParse(test).success && files.has(test)),
    'EVIDENCE_CHANGED',
    'A gate test is absent from the exact Candidate.',
  );
  return { scope: 'scoped', reason: gate.reason ?? `${gate.mode} gate`, tests };
}
