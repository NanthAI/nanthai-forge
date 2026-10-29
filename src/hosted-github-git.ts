// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import type { NativeFile } from './native-state-format.js';
import type { GithubSyncCommit } from './github-sync-types.js';
import { invariant } from './errors.js';
export const gitMode = (mode: NativeFile['mode']) =>
  mode === 'symlink' ? '120000' : mode === 'executable' ? '100755' : '100644';
export function gitHash(kind: string, bytes: Uint8Array) {
  return createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
}
/** Git sorts a directory as name + '/', and writes raw SHA bytes in trees. */
export function gitTree(files: { path: string; mode: NativeFile['mode']; sha: string }[]): string {
  type Tree = Map<string, { mode: string; sha: string } | Tree>;
  const root: Tree = new Map();
  for (const file of files) {
    const parts = file.path.split('/');
    let tree = root;
    for (const part of parts.slice(0, -1)) {
      if (!tree.has(part)) tree.set(part, new Map());
      const child = tree.get(part);
      invariant(child instanceof Map, 'GITHUB_SYNC_TREE', 'Source paths overlap.');
      tree = child;
    }
    tree.set(parts.at(-1)!, { mode: gitMode(file.mode), sha: file.sha });
  }
  const hash = (tree: Tree): string => {
    const entries = [...tree].sort(([a, av], [b, bv]) =>
      Buffer.compare(
        Buffer.from(a + (av instanceof Map ? '/' : '')),
        Buffer.from(b + (bv instanceof Map ? '/' : '')),
      ),
    );
    return gitHash(
      'tree',
      Buffer.concat(
        entries.map(([name, value]) => {
          const mode = value instanceof Map ? '40000' : value.mode;
          const sha = value instanceof Map ? hash(value) : value.sha;
          return Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(sha, 'hex')]);
        }),
      ),
    );
  };
  return hash(root);
}
/** Matches writeSyncCommit: UTC dates and a single terminating message newline. */
export function githubCommit(entry: Omit<GithubSyncCommit, 'commit'>) {
  const person = (p: typeof entry.author) => `${p.name} <${p.email}> ${entry.seconds} +0000`;
  return gitHash(
    'commit',
    Buffer.from(
      `tree ${entry.tree}\nparent ${entry.parent}\nauthor ${person(entry.author)}\ncommitter ${person(entry.committer)}\n\n${entry.message}\n`,
    ),
  );
}
