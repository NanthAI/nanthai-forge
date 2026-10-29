// SPDX-License-Identifier: Apache-2.0
import { mkdir, copyFile, chmod, symlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SourceWorkerReader } from './hosted-source-worker-reader.js';
import { parseNativeState } from './native-state-format.js';
import { checkPin } from './hosted-check.js';
import { semanticTests } from './intent-semantic-conflict.js';
import { digest } from './hash.js';
import { standardSelection } from '../scripts/test-impact.mjs';
import { partitionTests } from '../scripts/test-shards.mjs';
import { directSourceWindow } from './hosted-actions-direct.js';
import { hostedActionsRecipeSchema } from './hosted-actions.js';
import { ActionsJobClient } from './hosted-actions-job-client.js';
import { invariant } from './errors.js';
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
  const started = Date.now(),
    run = await client.session(true);
  invariant(run.configuration.provider === 'github-actions', 'RUNNER_UNAVAILABLE', 'Select Actions.');
  await mkdir(directory, { recursive: true });
  await mkdir(cache, { recursive: true });
  const { transport, resolve, prepareRecipes } = client.transport(),
    reader = new SourceWorkerReader(cache, transport);
  await resolve([run.request.expectedHead, run.candidate.base.head]);
  await prepareRecipes([run.request.expectedHead, run.candidate.base.head]);
  const [candidateRef, baseRef] = await transport.describeBatch!([
    run.request.expectedHead,
    run.candidate.base.head,
  ]);
  const state = parseNativeState(await reader.bytes(candidateRef!)),
    base = parseNativeState(await reader.bytes(baseRef!));
  let next = 0,
    completed = 0,
    failed = false;
  const worker = async () => {
    try {
      while (!failed && next < state.files.length) {
        const start = next;
        next += directSourceWindow;
        const page = state.files.slice(start, start + directSourceWindow),
          hashes = page.map(file => file.blob);
        await resolve(hashes);
        await prepareRecipes(hashes);
        await reader.resolveMany(hashes);
        for (const file of page) {
          if (file.mode === 'symlink') continue;
          const path = join(directory, file.path);
          await mkdir(dirname(path), { recursive: true });
          await copyFile(join(cache, file.blob), path);
          if (file.mode === 'executable') await chmod(path, 0o755);
        }
        completed += page.length;
        console.log(
          `Actions source: ${completed}/${state.files.length} files, ${reader.metrics.downloadedBytes} bytes, ${((Date.now() - started) / 1000).toFixed(1)}s`,
        );
      }
    } catch (error) {
      failed = true;
      throw error;
    }
  };
  // Drain in-flight work on failure before returning; links and plan publication
  // happen only after every page has succeeded. Bytes stay in streamed disk files.
  const pages = await Promise.allSettled(Array.from({ length: 3 }, worker));
  for (const page of pages) if (page.status === 'rejected') throw page.reason;
  // Create links after every regular file, so no source path can redirect writes.
  for (const file of state.files.filter(file => file.mode === 'symlink')) {
    await mkdir(dirname(join(directory, file.path)), { recursive: true });
    await symlink(readFileSync(join(cache, file.blob), 'utf8'), join(directory, file.path));
  }
  const inventory = new Map(state.files.map(file => [file.path, file])),
    old = new Map(base.files.map(file => [file.path, file]));
  const paths = [...new Set([...inventory.keys(), ...old.keys()])].filter(
    path => checkPin(inventory.get(path) ?? null) !== checkPin(old.get(path) ?? null),
  );
  const standard =
    /(?:^|\/)node$/.test(run.check.executable) &&
    JSON.stringify(run.check.args) === '["scripts/forge-check.mjs"]';
  const files = new SourceFiles(new Map(state.files.map(file => [file.path, file.blob])), cache);
  const selected = standard
    ? standardSelection({ paths, files, semanticTests: semanticTests(run.semanticPlan), env: {} })
    : { scope: 'full', reason: 'Exact configured command', tests: [] };
  const selection = { scope: selected.scope, reason: selected.reason, tests: selected.tests };
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
  return { run: client.run, recipe, matrix: [...groups.map((_, index) => String(index)), 'static'] };
}
