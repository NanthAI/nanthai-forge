// SPDX-License-Identifier: Apache-2.0
import type { NativeFile, NativeState } from './native-state-format.js';
import type { GithubSyncCommit } from './github-sync-types.js';
import { GithubMirrorApiError, type GithubRequest } from './hosted-github-api.js';
import { gitlinkCommit } from './gitlink.js';
import { isMissingObject, treeBlobPattern } from './hosted-github-retry.js';
import { gitHash, gitTree, gitMode, githubCommit } from './hosted-github-git.js';
import { publicationExclusion, sourceExclusion } from './files.js';
import { invariant } from './errors.js';
export const mirrorWindow = 100;
export const mirrorBytes = 8 * 1024 * 1024;
type GitFile = NativeFile & { sha: string };
export type MirrorSeed = {
  repository: string;
  state: string;
  previous: string;
  acceptanceId: string;
  viewId: string;
  message: string;
  at: string;
  operationId: string;
  binding: GithubSyncCommit | null;
  verified: boolean;
  identity: { name: string; email: string };
};
export type MirrorPlan = {
  seed: MirrorSeed;
  parent: string;
  baseTree: string;
  baseline: NativeFile[];
  phase: 'bootstrap' | 'blobs' | 'done';
  index: number;
  hashes: GitFile[];
  changes: {
    path: string;
    mode: string;
    type: 'blob' | 'commit';
    sha: string | null;
  }[];
  pending: NativeFile[];
  /** Bootstrap only, when the baseline tracks credential-looking names: the diff against a
   * GitHub tree that an older mirror wrote without them, used if GitHub's tree is that one. */
  legacy?: { changes: MirrorPlan['changes']; pending: NativeFile[] };
  entry: GithubSyncCommit | null;
};
/** Paths a mirror commit's tree holds: every tracked path except Forge metadata
 * (`tracked`), or, for a commit an older mirror wrote, also without credential-looking
 * names (`legacy`, `sourceExclusion`). Gitlinks are always published. */
const published = (rule: 'tracked' | 'legacy') => (file: NativeFile) =>
  file.mode === 'gitlink' || !(rule === 'tracked' ? publicationExclusion : sourceExclusion)(file.path);
function diff(files: NativeFile[], next: NativeFile[]) {
  const old = new Map(files.map(file => [file.path, file]));
  const after = new Map(next.map(file => [file.path, file]));
  const changes: MirrorPlan['changes'] = files
    .filter(file => !after.has(file.path))
    .map(file => ({
      path: file.path,
      mode: gitMode(file.mode),
      type: file.mode === 'gitlink' ? 'commit' : 'blob',
      sha: null,
    }));
  const pending = next.filter(file => {
    const before = old.get(file.path);
    return !before || before.blob !== file.blob || before.mode !== file.mode;
  });
  return { changes, pending };
}
export type MirrorIO = {
  api: GithubRequest;
  states(ids: string[]): Promise<NativeState[]>;
  blobs(ids: string[]): Promise<{ size: number; read(): Promise<Buffer> }[]>;
};
export async function prepareMirror(seed: MirrorSeed, io: MirrorIO): Promise<MirrorPlan> {
  const prefix = `/repos/${seed.repository}/git`;
  if (seed.verified && seed.binding) {
    const [baseline, target] = await io.states([seed.binding.state, seed.state]);
    invariant(baseline && target, 'SOURCE_UNAVAILABLE', 'Mirror source States are unavailable.');
    return diffPlan(seed, seed.binding.commit, seed.binding.tree, baseline, target, false);
  }
  const ref = await io.api<{ object: { sha: string } }>(`${prefix}/ref/heads/main`);
  const remote = ref.object.sha;
  const commit = await io.api<{ tree: { sha: string }; message: string }>(`${prefix}/commits/${remote}`);
  invariant(
    !seed.binding || seed.binding.commit === remote,
    'GITHUB_SYNC_CHANGED',
    'GitHub main moved away from the retained Forge mirror mapping. No ref was changed.',
  );
  // A retained Mac mapping is preferred. Otherwise a public Forge-State trailer
  // names the candidate baseline; its exact source tree is still verified below.
  const previous =
    seed.binding?.state ?? commit.message.match(/^Forge-State: ([0-9a-f]{64})$/m)?.[1] ?? seed.previous;
  const [baseline, target] = await io.states([previous, seed.state]);
  invariant(baseline && target, 'SOURCE_UNAVAILABLE', 'Mirror source States are unavailable.');
  return diffPlan(seed, remote, commit.tree.sha, baseline, target, true);
}
function diffPlan(
  seed: MirrorSeed,
  parent: string,
  baseTree: string,
  baseline: NativeState,
  target: NativeState,
  bootstrap: boolean,
): MirrorPlan {
  const next = target.files.filter(published('tracked'));
  const files = baseline.files.filter(published('tracked')),
    legacyFiles = baseline.files.filter(published('legacy'));
  // A verified mapping says which rule wrote GitHub's tree; an older one dropped tracked
  // credential-looking names, so this commit adds them back. Bootstrap checks both below.
  const legacy = !bootstrap && seed.binding?.publication !== 'tracked';
  const { changes, pending } = diff(legacy ? legacyFiles : files, next);
  const fallback = bootstrap && legacyFiles.length !== files.length ? diff(legacyFiles, next) : undefined;
  return {
    seed,
    parent,
    baseTree,
    baseline: bootstrap ? files : [],
    phase: bootstrap ? 'bootstrap' : 'blobs',
    index: 0,
    hashes: [],
    changes,
    pending,
    ...(fallback ? { legacy: fallback } : {}),
    entry: null,
  };
}
/** Blob SHAs a tree POST 422 rejected as "tree.sha X is not a valid blob". */
export function invalidTreeBlobs(error: unknown): string[] {
  if (
    !(error instanceof GithubMirrorApiError) ||
    error.status !== 422 ||
    error.operation !== 'POST git/trees'
  )
    return [];
  const named = (error.githubError ?? '').matchAll(new RegExp(treeBlobPattern.source, 'g'));
  return [...new Set([...named].map(match => match[1]!))];
}
/** Shared scheduled-retry gate (hosted-github-retry.ts): a 422 on git/trees or
 * git/commits naming a missing/invalid SHA this job created or uploaded. A tree
 * entry naming a SHA outside this plan's own blobs is not ours: terminal. */
export function missingObjectError(error: unknown, plan: MirrorPlan | undefined): boolean {
  if (
    !(error instanceof GithubMirrorApiError) ||
    !isMissingObject(error.status, error.operation, error.githubError)
  )
    return false;
  if (error.operation !== 'POST git/trees') return true;
  const named = invalidTreeBlobs(error);
  return (
    !!plan &&
    named.length > 0 &&
    named.every(sha => plan.changes.some(entry => entry.type === 'blob' && entry.sha === sha))
  );
}
/** GitHub can accept a blob POST (201, same SHA) yet reject that SHA in a later
 * tree POST, for example when the object already existed unreachable from a
 * deleted check ref (incident 8568bc76). Re-upload exactly the named blobs of
 * this tree from verified Forge bytes, then retry the identical tree once.
 * Bounded by the tree's own entries; a second failure throws to the shared
 * scheduled policy (hosted-github-retry.ts), which ends terminal. */
async function createTree(plan: MirrorPlan, io: MirrorIO, prefix: string): Promise<string> {
  const body = { base_tree: plan.baseTree, tree: plan.changes };
  try {
    return (await io.api<{ sha: string }>(`${prefix}/trees`, 'POST', body)).sha;
  } catch (error) {
    const named = invalidTreeBlobs(error);
    const sources = named.map(sha => {
      const change = plan.changes.find(entry => entry.type === 'blob' && entry.sha === sha);
      return change && plan.pending.find(file => file.path === change.path && file.mode !== 'gitlink');
    });
    if (!named.length || sources.some(file => !file)) throw error;
    const objects = await io.blobs(sources.map(file => file!.blob));
    invariant(objects.length === named.length, 'SOURCE_UNAVAILABLE', 'Mirror blob window is incomplete.');
    for (let i = 0; i < named.length; i++) {
      const content = await objects[i]!.read();
      invariant(
        gitHash('blob', content) === named[i],
        'GITHUB_SYNC_HASH',
        'Forge source differs from the tree entry.',
      );
      const result = await io.api<{ sha: string }>(`${prefix}/blobs`, 'POST', {
        content: content.toString('base64'),
        encoding: 'base64',
      });
      invariant(result.sha === named[i], 'GITHUB_SYNC_HASH', 'GitHub returned different blob bytes.');
    }
    try {
      return (await io.api<{ sha: string }>(`${prefix}/trees`, 'POST', body)).sha;
    } catch (retry) {
      if (retry instanceof GithubMirrorApiError)
        retry.message += ` Forge re-uploaded ${named.length} named blob(s) and retried the tree once in this step.`;
      throw retry;
    }
  }
}
/** Every tick creates at most 100 blobs / 8 MiB (or one larger logical file).
 * Metadata is a compact tree/diff cursor, never a Work snapshot or history scan. */
export async function stepMirror(plan: MirrorPlan, io: MirrorIO, now = Date.now): Promise<MirrorPlan> {
  if (plan.phase === 'done') return plan;
  const prefix = `/repos/${plan.seed.repository}/git`;
  const deadline = now() + 60_000;
  let count = 0,
    bytes = 0;
  while (plan.phase !== 'done') {
    const files = plan.phase === 'bootstrap' ? plan.baseline : plan.pending;
    const window = files.slice(plan.index, plan.index + mirrorWindow - count);
    if (window.length) {
      const objects = await io.blobs(window.map(file => file.blob));
      invariant(objects.length === window.length, 'SOURCE_UNAVAILABLE', 'Mirror blob window is incomplete.');
      for (let i = 0; i < window.length; i++) {
        const object = objects[i]!,
          file = window[i]!;
        if (count && bytes + object.size > mirrorBytes) return plan;
        const content = await object.read();
        const sha = file.mode === 'gitlink' ? gitlinkCommit(content) : gitHash('blob', content);
        if (plan.phase === 'bootstrap') plan.hashes.push({ ...file, sha });
        else {
          if (file.mode === 'gitlink') {
            plan.changes.push({
              path: file.path,
              mode: '160000',
              type: 'commit',
              sha,
            });
          } else {
            const result = await io.api<{ sha: string }>(`${prefix}/blobs`, 'POST', {
              content: content.toString('base64'),
              encoding: 'base64',
            });
            invariant(result.sha === sha, 'GITHUB_SYNC_HASH', 'GitHub returned different blob bytes.');
            plan.changes.push({
              path: file.path,
              mode: gitMode(file.mode),
              type: 'blob',
              sha,
            });
          }
        }
        count++;
        bytes += content.length;
        plan.index++;
        if (count === mirrorWindow || bytes >= mirrorBytes || now() >= deadline) break;
      }
      if (plan.index < files.length) return plan;
    }
    if (plan.phase === 'bootstrap') {
      if (gitTree(plan.hashes) !== plan.baseTree) {
        invariant(
          plan.legacy && gitTree(plan.hashes.filter(published('legacy'))) === plan.baseTree,
          'GITHUB_SYNC_BOOTSTRAP_TREE',
          'GitHub main tree differs from its matching Forge State. No mapping was trusted and no ref was changed.',
        );
        // An older mirror left tracked credential-looking names out: publish them now.
        plan.changes = plan.legacy.changes;
        plan.pending = plan.legacy.pending;
      }
      delete plan.legacy;
      plan.baseline = [];
      plan.hashes = [];
      plan.phase = 'blobs';
      plan.index = 0;
      if (count === mirrorWindow || bytes >= mirrorBytes || now() >= deadline) return plan;
      continue;
    }
    let tree = plan.baseTree;
    if (plan.changes.length) tree = await createTree(plan, io, prefix);
    const seed = plan.seed;
    const entry = {
      publication: 'tracked' as const,
      operationId: seed.operationId,
      state: seed.state,
      acceptanceId: seed.acceptanceId,
      viewId: seed.viewId,
      parent: plan.parent,
      tree,
      message: seed.message,
      author: seed.identity,
      committer: seed.identity,
      seconds: Math.floor(Date.parse(seed.at) / 1000),
    };
    const commit = tree === plan.baseTree ? plan.parent : githubCommit(entry);
    const current = await io.api<{ object: { sha: string } }>(`${prefix}/ref/heads/main`);
    invariant(
      [plan.parent, commit].includes(current.object.sha),
      'GITHUB_SYNC_CHANGED',
      'GitHub main moved unexpectedly. Mirror stopped without changing its ref.',
    );
    if (current.object.sha !== commit) {
      const date = new Date(entry.seconds * 1000).toISOString();
      const created = await io.api<{ sha: string }>(`${prefix}/commits`, 'POST', {
        tree,
        parents: [plan.parent],
        message: `${entry.message}\n`,
        author: { ...entry.author, date },
        committer: { ...entry.committer, date },
      });
      invariant(
        created.sha === commit,
        'GITHUB_SYNC_HASH',
        'GitHub commit differs from the deterministic mirror commit.',
      );
      await io.api(`${prefix}/refs/heads/main`, 'PATCH', {
        sha: commit,
        force: false,
      });
    }
    plan.entry = { ...entry, commit };
    plan.phase = 'done';
  }
  return plan;
}
