// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';
import { mergeNativeText } from './native-text-merge.js';
import { gitIsAncestor, workGit } from './work-git.js';

export function changed(
  heads: { expectedHead: string; remoteHead: string; localHead?: string },
  detail = 'The remote ref moved during sync. Retry the retained operation; both heads are retained.',
) {
  return Object.assign(
    new ForgeError('GITHUB_SYNC_CHANGED', `GitHub changed outside Forge. ${detail}`),
    heads,
  );
}

export type GithubTreeEntry = { mode: string; object: string };
type Entry = GithubTreeEntry | undefined;
export type GithubHistoryProof = {
  path: string;
  state: string;
  acceptanceId: string;
  viewId: string;
  kind: 'accepted-main' | 'accepted-lane-checkpoint';
  laneId?: string;
  checkpoint?: number;
};
export type GithubHistoryTarget = { path: string; entry: Entry };
const same = (a: Entry, b: Entry) => a === b || (!!a && !!b && a.mode === b.mode && a.object === b.object);
function entries(root: string, tree: string) {
  return new Map(
    workGit(root, ['ls-tree', '-r', '-z', tree])
      .split('\0')
      .filter(Boolean)
      .map(row => {
        const tab = row.indexOf('\t'),
          [mode, , object] = row.slice(0, tab).split(' ');
        return [row.slice(tab + 1), { mode: mode!, object: object! }];
      }),
  );
}

/** A clean three-way merge must preserve both Forge bytes and mode exactly. */
function notContained(root: string, path: string, base: Entry, ours: Entry, theirs: Entry) {
  if (same(ours, theirs) || same(base, theirs)) return;
  if (!base) return ours ? 'conflicting additions' : 'external addition would change Forge content';
  if (!ours) return 'Forge deletion conflicts with external changes';
  if (!theirs)
    return same(base, ours)
      ? 'external deletion would change Forge content'
      : 'external deletion conflicts with Forge changes';
  if (ours.mode !== theirs.mode && base.mode !== theirs.mode)
    return ours.mode === base.mode ? 'merge would change Forge mode' : 'conflicting modes';
  if (ours.object === theirs.object || base.object === theirs.object) return;
  if (ours.object === base.object) return 'merge would change Forge content';
  // Symlink targets and gitlinks are atomic; only regular file bytes use diff3.
  if (![base, ours, theirs].every(entry => ['100644', '100755'].includes(entry.mode)))
    return 'conflicting non-regular file content';
  const bytes = (entry: NonNullable<Entry>) =>
    workGit(root, ['cat-file', 'blob', entry.object], undefined, false, true);
  const current = bytes(ours),
    merged = mergeNativeText(bytes(base), current, bytes(theirs), path);
  if (!merged) return 'content conflicts or cannot be merged as text';
  if (!merged.equals(current)) return 'merge would change Forge content';
}

/** Merge the recorded-to-GitHub delta into the Forge export without changing it. */
export function githubReconciliation(
  root: string,
  expected: string,
  remote: string,
  tree: string,
  history?: (targets: GithubHistoryTarget[]) => GithubHistoryProof[],
) {
  // A rewritten remote may no longer advertise the recorded commit at all.
  const available =
    expected &&
    workGit(root, ['rev-parse', '--verify', '--quiet', `${expected}^{commit}`], undefined, true).trim();
  if (!available || !gitIsAncestor(root, expected, remote))
    return {
      status: 'rewritten' as const,
      commits: [],
      paths: [],
      missingPaths: [],
      missingPathReasons: [],
      historyProofs: [],
    };
  const paths = workGit(root, [
    'diff-tree',
    '--no-commit-id',
    '--no-renames',
    '--name-only',
    '-r',
    '-z',
    expected,
    remote,
  ])
    .split('\0')
    .filter(Boolean);
  const base = entries(root, expected),
    ours = entries(root, tree),
    theirs = entries(root, remote),
    strictFailures = paths.flatMap(path => {
      const reason = notContained(root, path, base.get(path), ours.get(path), theirs.get(path));
      return reason ? [{ path, reason }] : [];
    }),
    // An exact recorded version is a shared base: base == theirs merges to ours.
    historyProofs = strictFailures.length
      ? (history?.(strictFailures.map(({ path }) => ({ path, entry: theirs.get(path) }))) ?? [])
      : [],
    proven = new Set(historyProofs.map(proof => proof.path)),
    missingPathReasons = strictFailures.filter(item => !proven.has(item.path)),
    missingPaths = missingPathReasons.map(item => item.path);
  return {
    status: missingPaths.length ? ('not-contained' as const) : ('contained' as const),
    commits: workGit(root, ['rev-list', '--reverse', `${expected}..${remote}`])
      .trim()
      .split('\n')
      .filter(Boolean),
    paths,
    missingPaths,
    missingPathReasons,
    historyProofs,
  };
}

export function reconciliationDetail(result: ReturnType<typeof githubReconciliation>) {
  if (result.status === 'rewritten')
    return 'GitHub history was rewritten: its head is not a descendant of the recorded commit. Both heads are retained; restore the recorded history or import the external work as a contribution Lane before retrying.';
  return `External commits: ${result.commits.join(', ')}. Paths not contained in exported main: ${JSON.stringify(result.missingPathReasons)}. Create a contribution Lane with nforge agent ROOT start, review the external diff there and reconcile only the missing changes with current main, then accept into main and retry github-sync --push. Both heads are retained.`;
}
