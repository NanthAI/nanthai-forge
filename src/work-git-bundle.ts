// SPDX-License-Identifier: Apache-2.0
import { chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprintPrivateFile } from './files.js';
import { invariant } from './errors.js';
import { nativeGitRunner } from './native-git-runner.js';

export async function fullGitBundle(
  transport: string,
  refs: { ref: string; head: string }[],
  temp: string,
  code: string,
  git: (root: string, args: string[]) => string | Promise<string> = nativeGitRunner(false).git,
) {
  for (const item of refs) await git(transport, ['update-ref', item.ref, item.head]);
  await git(transport, [
    '--no-lazy-fetch',
    '--no-replace-objects',
    'bundle',
    'create',
    '--progress',
    // Git 2.38 needs this to report progress while pack objects are written.
    '--all-progress-implied',
    temp,
    ...refs.map(item => item.ref),
  ]);
  chmodSync(temp, 0o600);
  unlinkSync(join(transport, 'objects/info/alternates'));
  const heads = (await git(transport, ['bundle', 'list-heads', temp])).trim();
  invariant(
    heads.split('\n').sort().join('\n') ===
      refs
        .map(item => `${item.head} ${item.ref}`)
        .sort()
        .join('\n'),
    code,
    'The bundle names different source.',
  );
  // Verify without source alternates: native Git checks self-contained prerequisites, pack integrity and ancestry connectivity.
  await git(transport, ['--no-lazy-fetch', '--no-replace-objects', 'bundle', 'verify', temp]);
  await git(transport, ['--no-lazy-fetch', '--no-replace-objects', 'bundle', 'unbundle', '--progress', temp]);
  await git(transport, [
    '--no-lazy-fetch',
    '--no-replace-objects',
    'fsck',
    '--progress',
    '--connectivity-only',
    '--no-reflogs',
  ]);
  return fingerprintPrivateFile(temp, code);
}
