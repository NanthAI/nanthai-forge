// SPDX-License-Identifier: Apache-2.0
import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HostedCheckRun } from './hosted-check.js';
import { contractTestPath } from './intent-test-contract.js';
import { checkPin } from './hosted-check.js';
import { semanticTests } from './intent-semantic-conflict.js';
import { digest } from './hash.js';
import { standardSelection } from '../scripts/test-impact.mjs';
import { partitionTests } from '../scripts/test-shards.mjs';
import { hostedActionsRecipeSchema } from './hosted-actions.js';
import { ActionsJobClient } from './hosted-actions-job-client.js';
import { invariant } from './errors.js';
import { materializeActionsSource } from './hosted-actions-job-source.js';
import { refreshSourcePack } from './source-pack.js';
import { refreshActionsSourcePack } from './hosted-actions-job-pack.js';
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
export async function prepareActionsJob(client: ActionsJobClient, directory: string, cache: string) {
  console.log('Actions source: preparing pinned Candidate');
  const run = await client.session(true);
  invariant(run.configuration.provider === 'github-actions', 'RUNNER_UNAVAILABLE', 'Select Actions.');
  await mkdir(directory, { recursive: true });
  await mkdir(cache, { recursive: true });
  const source = await materializeActionsSource(client, directory, cache);
  const { state, base } = source;
  const inventory = new Map(state.files.map(file => [file.path, file])),
    old = new Map(base.files.map(file => [file.path, file]));
  const paths = [...new Set([...inventory.keys(), ...old.keys()])].filter(
    path => checkPin(inventory.get(path) ?? null) !== checkPin(old.get(path) ?? null),
  );
  const standard =
    /(?:^|\/)node$/.test(run.check.executable) &&
    JSON.stringify(run.check.args) === '["scripts/forge-check.mjs"]';
  const files = new SourceFiles(new Map(state.files.map(file => [file.path, file.blob])), cache);
  const selected = actionsGateSelection(run, paths, files, standard);
  const selection = {
    scope: selected.scope,
    reason: selected.reason,
    tests: selected.tests,
    ...(run.gate
      ? {
          gate: {
            ...run.gate,
            effective: selected.scope === 'full' ? 'full' : selected.scope === 'docs' ? 'docs' : 'contract',
          },
        }
      : {}),
  };
  const groups =
    standard && selection.scope !== 'docs' ? partitionTests(selection.tests, 8, client.timings) : [];
  const pins = {
    head: run.request.expectedHead,
    definition: run.check.definition,
    selection,
    groups,
    standard,
    interaction: false,
    command: [standard ? 'node' : run.check.executable, ...run.check.args],
  };
  const recipe = hostedActionsRecipeSchema.parse({ pin: checkPin(pins), ...pins });
  const lock = inventory.get('package-lock.json');
  client.run = (await client.call({
    kind: 'plan',
    plan: { recipe, lockfile: digest(lock ? readFileSync(join(cache, lock.blob)) : Buffer.alloc(0)) },
  })) as typeof run;
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
    recipe,
    matrix: [...groups.map((_, index) => String(index)), 'static'],
  };
}

/** Gate metadata is sent only in response to a server-stamped run (skew handshake). */
export function actionsGateSelection(
  run: HostedCheckRun,
  paths: string[],
  files: Map<string, string>,
  standard: boolean,
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
