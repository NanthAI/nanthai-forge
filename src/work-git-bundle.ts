// SPDX-License-Identifier: Apache-2.0
import { chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprintPrivateFile } from './files.js';
import { invariant } from './errors.js';
import { workGit } from './work-git.js';

export async function fullGitBundle(
  transport: string,
  refs: { ref: string; head: string }[],
  temp: string,
  code: string,
) {
  for (const item of refs) workGit(transport, ['update-ref', item.ref, item.head]);
  workGit(transport, [
    '--no-lazy-fetch',
    '--no-replace-objects',
    'bundle',
    'create',
    temp,
    ...refs.map(item => item.ref),
  ]);
  chmodSync(temp, 0o600);
  unlinkSync(join(transport, 'objects/info/alternates'));
  const heads = workGit(transport, ['bundle', 'list-heads', temp]).trim();
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
  workGit(transport, ['--no-lazy-fetch', '--no-replace-objects', 'bundle', 'verify', temp]);
  workGit(transport, ['--no-lazy-fetch', '--no-replace-objects', 'bundle', 'unbundle', temp]);
  workGit(transport, [
    '--no-lazy-fetch',
    '--no-replace-objects',
    'fsck',
    '--connectivity-only',
    '--no-reflogs',
  ]);
  return fingerprintPrivateFile(temp, code);
}
