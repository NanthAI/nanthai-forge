// SPDX-License-Identifier: Apache-2.0
import type { NativeFile, NativeState } from './native-state-format.js';
import type { GithubSyncCommit } from './github-sync-types.js';
import type { GithubRequest } from './hosted-github-api.js';
import { gitHash, gitTree, gitMode, githubCommit } from './hosted-github-git.js';
import { sourceExclusion } from './files.js';
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
  changes: { path: string; mode: string; type: 'blob'; sha: string | null }[];
  pending: NativeFile[];
  entry: GithubSyncCommit | null;
};
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
  const files = baseline.files.filter(file => !sourceExclusion(file.path));
  const next = target.files.filter(file => !sourceExclusion(file.path));
  const old = new Map(files.map(file => [file.path, file]));
  const after = new Map(next.map(file => [file.path, file]));
  const changes: MirrorPlan['changes'] = files
    .filter(file => !after.has(file.path))
    .map(file => ({ path: file.path, mode: gitMode(file.mode), type: 'blob', sha: null }));
  const pending = next.filter(file => {
    const before = old.get(file.path);
    return !before || before.blob !== file.blob || before.mode !== file.mode;
  });
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
    entry: null,
  };
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
        const sha = gitHash('blob', content);
        if (plan.phase === 'bootstrap') plan.hashes.push({ ...file, sha });
        else {
          const result = await io.api<{ sha: string }>(`${prefix}/blobs`, 'POST', {
            content: content.toString('base64'),
            encoding: 'base64',
          });
          invariant(result.sha === sha, 'GITHUB_SYNC_HASH', 'GitHub returned different blob bytes.');
          plan.changes.push({ path: file.path, mode: gitMode(file.mode), type: 'blob', sha });
        }
        count++;
        bytes += content.length;
        plan.index++;
        if (count === mirrorWindow || bytes >= mirrorBytes || now() >= deadline) break;
      }
      if (plan.index < files.length) return plan;
    }
    if (plan.phase === 'bootstrap') {
      invariant(
        gitTree(plan.hashes) === plan.baseTree,
        'GITHUB_SYNC_BOOTSTRAP_TREE',
        'GitHub main tree differs from its matching Forge State. No mapping was trusted and no ref was changed.',
      );
      plan.baseline = [];
      plan.hashes = [];
      plan.phase = 'blobs';
      plan.index = 0;
      if (count === mirrorWindow || bytes >= mirrorBytes || now() >= deadline) return plan;
      continue;
    }
    let tree = plan.baseTree;
    if (plan.changes.length) {
      const result = await io.api<{ sha: string }>(`${prefix}/trees`, 'POST', {
        base_tree: plan.baseTree,
        tree: plan.changes,
      });
      tree = result.sha;
    }
    const seed = plan.seed;
    const entry = {
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
      await io.api(`${prefix}/refs/heads/main`, 'PATCH', { sha: commit, force: false });
    }
    plan.entry = { ...entry, commit };
    plan.phase = 'done';
  }
  return plan;
}
