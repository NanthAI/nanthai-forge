// SPDX-License-Identifier: Apache-2.0
import { stateSchema, type NativeFile, type NativeState } from './native-state-format.js';
import type { GithubRequest } from './hosted-github-api.js';
import { publicationExclusion } from './files.js';
import { digest } from './portable-hash.js';
import { ForgeError, invariant } from './errors.js';

/** One GitHub path change between two trees: the new entry, or null when removed. */
export type InboundChange = {
  path: string;
  after: { mode: NativeFile['mode']; sha: string } | null;
};
type TreeEntry = { path: string; mode: string; type: string; sha: string };
/** Changed directories one inbound step may walk (two tree reads each). Larger pushes are
 * refused visibly, never truncated. */
export const inboundDirectoryLimit = 500;
/** Changed files one inbound step brings in; above this the job fails visibly. */
export const inboundFileLimit = 5000;

function nativeMode(mode: string): NativeFile['mode'] | null {
  if (mode === '100644' || mode === '100664') return 'file';
  if (mode === '100755') return 'executable';
  if (mode === '120000') return 'symlink';
  if (mode === '160000') return 'gitlink';
  return null;
}
/** Diff two GitHub trees by walking only subtrees whose SHA differs: GitHub calls
 * grow with changed directories, never with repository size, and no recursive
 * listing can be truncated. Paths Forge never publishes are skipped both ways. */
export async function diffGithubTrees(
  api: GithubRequest,
  repository: string,
  before: string,
  after: string,
): Promise<{ changes: InboundChange[]; skipped: number; directories: number }> {
  const changes: InboundChange[] = [];
  let skipped = 0,
    directories = 0;
  const list = async (sha: string | null) => {
    if (!sha) return new Map<string, TreeEntry>();
    const tree = await api<{ tree: TreeEntry[]; truncated?: boolean }>(
      `/repos/${repository}/git/trees/${sha}`,
    );
    invariant(!tree.truncated, 'GITHUB_INBOUND_TOO_LARGE', 'A GitHub directory listing was truncated.');
    return new Map(tree.tree.map(entry => [entry.path, entry]));
  };
  const flatten = async (prefix: string, sha: string, side: 'before' | 'after') => {
    // A whole added or removed directory: list it once, its subtrees as they come.
    const walk = async (dir: string, tree: string) => {
      invariant(++directories <= inboundDirectoryLimit, 'GITHUB_INBOUND_TOO_LARGE', 'Too many directories.');
      for (const entry of (await list(tree)).values()) {
        const path = `${dir}${entry.path}`;
        if (entry.type === 'tree') await walk(`${path}/`, entry.sha);
        else record(path, side === 'before' ? null : entry, side === 'before' ? entry : null);
      }
    };
    await walk(prefix, sha);
  };
  const record = (path: string, entry: TreeEntry | null, previous: TreeEntry | null) => {
    if (publicationExclusion(path)) {
      skipped++;
      return;
    }
    if (!entry) {
      changes.push({ path, after: null });
      return;
    }
    const mode = nativeMode(entry.mode);
    if (!mode) throw new ForgeError('GITHUB_INBOUND_MODE', `GitHub path ${path} has an unsupported mode.`);
    if (previous && previous.sha === entry.sha && previous.mode === entry.mode) return;
    changes.push({ path, after: { mode, sha: entry.sha } });
  };
  const visit = async (prefix: string, left: string | null, right: string | null) => {
    if (left === right) return;
    invariant(++directories <= inboundDirectoryLimit, 'GITHUB_INBOUND_TOO_LARGE', 'Too many directories.');
    const [old, next] = await Promise.all([list(left), list(right)]);
    for (const name of new Set([...old.keys(), ...next.keys()])) {
      const a = old.get(name),
        b = next.get(name),
        path = `${prefix}${name}`;
      const aTree = a?.type === 'tree' ? a : null,
        bTree = b?.type === 'tree' ? b : null;
      if (aTree && bTree) await visit(`${path}/`, aTree.sha, bTree.sha);
      else {
        if (aTree) await flatten(`${path}/`, aTree.sha, 'before');
        if (bTree) await flatten(`${path}/`, bTree.sha, 'after');
        const aFile = a && !aTree ? a : null,
          bFile = b && !bTree ? b : null;
        if (aFile || bFile) record(path, bFile, aFile);
      }
    }
  };
  await visit('', before, after);
  invariant(changes.length <= inboundFileLimit, 'GITHUB_INBOUND_TOO_LARGE', 'Too many changed files.');
  return {
    changes: changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    skipped,
    directories,
  };
}
/** Paths GitHub changed that Forge's base also changed since the State GitHub matched:
 * those cannot be brought in by path and fail the inbound job visibly. */
export function inboundConflicts(
  equivalent: NativeState,
  base: NativeState,
  changes: readonly InboundChange[],
): string[] {
  if (equivalent === base) return [];
  const a = new Map(equivalent.files.map(file => [file.path, file])),
    b = new Map(base.files.map(file => [file.path, file]));
  return changes
    .filter(({ path }) => {
      const x = a.get(path),
        y = b.get(path);
      return (x?.blob ?? null) !== (y?.blob ?? null) || (x?.mode ?? null) !== (y?.mode ?? null);
    })
    .map(change => change.path);
}
/** The State that holds `state`'s files with GitHub's changes applied, as exact bytes and pin. */
export function applyInbound(
  state: NativeState,
  parent: string,
  changes: readonly { path: string; after: { mode: NativeFile['mode']; blob: string } | null }[],
  message: string,
  at: string,
) {
  const files = new Map(state.files.map(file => [file.path, file]));
  for (const change of changes)
    if (change.after) files.set(change.path, { path: change.path, ...change.after });
    else files.delete(change.path);
  const bytes = new TextEncoder().encode(
    JSON.stringify(
      stateSchema.parse({
        schema: 1,
        kind: 'forge-source-state',
        parents: [parent],
        files: [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
        message,
        at,
      }),
    ),
  );
  return { bytes, pin: { sha256: digest(bytes), size: bytes.length } };
}
/** Forge's stored bytes for one GitHub tree entry: blob bytes, or a gitlink's pinned commit
 * exactly as import stores it (src/github-project-source.ts). */
export function inboundBytes(mode: NativeFile['mode'], sha: string, blob: () => Promise<Uint8Array>) {
  return mode === 'gitlink' ? Promise.resolve(new TextEncoder().encode(sha)) : blob();
}
