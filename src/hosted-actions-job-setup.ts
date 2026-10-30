// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { childEnv } from '../scripts/child-env.mjs';
import { digest } from './hash.js';
import { parseNativeState } from './native-state-format.js';
import { verifySourceTree } from './hosted-actions-job-source.js';
import type { HostedCheckRun } from './hosted-check.js';
import { invariant } from './errors.js';

/** Local artifacts only: no metadata requests, credentials or setup test reports.
 * Cache preparation is advisory. The pinned Candidate must survive it unchanged. */
export async function setupActionsJob(run: HostedCheckRun, directory: string, planPath: string) {
  const setup = run.check.actions?.setup;
  if (!setup) return undefined;
  const bytes = await readFile(join(dirname(planPath), 'forge-actions-state.json'));
  invariant(digest(bytes) === run.request.expectedHead, 'SOURCE_HASH_MISMATCH', 'Setup State differs.');
  const state = parseNativeState(bytes);
  const verify = async () => {
    const expected = new Set(state.files.map(file => file.path));
    const walk = async (prefix: string) => {
      for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path);
        else {
          invariant(expected.delete(path), 'SOURCE_HASH_MISMATCH', 'Setup added source.');
        }
      }
    };
    await walk('');
    invariant(expected.size === 0, 'SOURCE_HASH_MISMATCH', 'Setup removed source.');
    await verifySourceTree(state, directory);
  };
  await verify();
  const cache = resolve(process.env.FORGE_SOURCE_CACHE_DIR || join(dirname(planPath), 'forge-setup-cache'));
  try {
    await mkdir(cache, { recursive: true });
  } catch {
    console.log('Actions cache setup unavailable; using cold path.');
    return undefined;
  }
  const code = await new Promise<number>(resolve => {
    const child = spawn(setup.executable, setup.args, {
      cwd: cache,
      shell: false,
      stdio: 'ignore',
      env: { ...childEnv({ allow: ['CI', 'PATH'] }), FORGE_SOURCE_CACHE_DIR: cache },
    });
    child.once('error', () => resolve(127));
    child.once('close', code => resolve(code ?? 128));
  });
  console.log(
    code === 0 ? 'Actions cache setup complete.' : 'Actions cache setup unavailable; using cold path.',
  );
  await verify();
  return cache;
}
