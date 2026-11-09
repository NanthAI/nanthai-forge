// SPDX-License-Identifier: Apache-2.0
'use node';
import { convexFetch, networkTimeout } from './networkFetch';
import { makeFunctionReference } from 'convex/server';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { inboundReadPermissions, installationTokenMinter, pullCheckPermissions } from './githubAppToken';
import { postPullStatus } from './projectGithubPullStatus';
import type { PullJob } from '../src/github-pull-check';
import { commitObjects } from './projectObjectCommit';
import type { PreparedObject } from './projectObjects';
import { githubRequest, type GithubRequest } from '../src/hosted-github-api';
import { gitHash } from '../src/hosted-github-git';
import { applyInbound, diffGithubTrees, inboundConflicts, type InboundChange } from '../src/github-inbound';
import { bringInChanges } from '../src/github-inbound-bytes';
import { isGitattributesPath } from '../src/github-lfs';
import { lfsAttributeBytes } from '../src/github-lfs-import';
import type { NativeFile } from '../src/native-state-format';
import { digest } from '../src/portable-hash';
import { ForgeError, invariant } from '../src/errors';

const mutation = (name: string) => makeFunctionReference<'mutation'>(name);
const query = (name: string) => makeFunctionReference<'query'>(name);
type Identity = { jobId: Id<'projectGithubMirrorJobs'>; step: number };
type Pin = { sha256: string; size: number };
export type InboundBegin = {
  inbound: true;
  projectId: Id<'hostedProjects'>;
  owner: string;
  repository: string;
  phase: 'pending' | 'compose';
  uploads: { value: string; pin: Pin }[] | null;
  mapping: { commit: string; tree: string; state: string };
  base: { head: string; receiptId: string };
  /** A pull request job: check this PR head instead of bringing GitHub main in. */
  pull?: PullJob;
  /** The Forge project page, for the pending forge/verify status. */
  link?: string | null;
};
/** Objects per prepare window: one mutation and one commit round each, never per file. */
const window = 99;
async function put(target: PreparedObject['target'], body: Uint8Array) {
  invariant(target, 'SOURCE_UNAVAILABLE', 'Inbound upload target is unavailable.');
  const response = await convexFetch(target.url, {
    method: 'PUT',
    headers: target.headers,
    body: Buffer.from(body),
    signal: networkTimeout(60_000),
  });
  // 412: the create-only object is already there with these exact bytes.
  invariant(response.ok || response.status === 412, 'R2_UPLOAD_FAILED', 'Inbound upload failed.');
}
/** Upload new objects in windows of 99: prepare, PUT the bytes to R2, verify and commit. */
async function store(ctx: ActionCtx, input: Identity, owner: string, objects: Uint8Array[]) {
  const pins: Pin[] = [];
  for (let i = 0; i < objects.length; i += window) {
    const slice = objects.slice(i, i + window);
    const ids = slice.map(bytes => ({ sha256: digest(bytes), size: bytes.length }));
    const prepared: PreparedObject[] = JSON.parse(
      await ctx.runMutation(mutation('projectGithubInbound:prepareUploads'), { ...input, objects: ids }),
    );
    await Promise.all(prepared.map((row, j) => (row.stored ? null : put(row.target, slice[j]!))));
    await commitObjects(
      ctx,
      owner,
      prepared.filter(row => !row.stored).map(row => ({ id: row.id })),
    );
    pins.push(...ids);
  }
  return pins;
}
async function blob(api: GithubRequest, repository: string, sha: string) {
  const value = await api<{ content: string; encoding: string }>(`/repos/${repository}/git/blobs/${sha}`);
  invariant(value.encoding === 'base64', 'GITHUB_RESPONSE', 'GitHub returned an unexpected blob encoding.');
  const bytes = Buffer.from(value.content, 'base64');
  invariant(gitHash('blob', bytes) === sha, 'GITHUB_SYNC_HASH', 'GitHub returned different blob bytes.');
  return bytes;
}
/** A `.gitattributes` file of GitHub's new tree this push did not change, as text; null when
 * it is over the size Git LFS resolution reads. */
async function attributesAt(api: GithubRequest, repository: string, commit: string, path: string) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const file = await api<{ content?: string; encoding?: string; sha: string; size: number }>(
    `/repos/${repository}/contents/${encoded}?ref=${commit}`,
  );
  if (file.size > lfsAttributeBytes) return null;
  invariant(
    file.encoding === 'base64' && file.content,
    'GITHUB_RESPONSE',
    'GitHub returned an unexpected file encoding.',
  );
  const bytes = Buffer.from(file.content, 'base64');
  invariant(gitHash('blob', bytes) === file.sha, 'GITHUB_SYNC_HASH', 'GitHub returned different file bytes.');
  return bytes.toString('utf8');
}
/** Bring GitHub main in: diff GitHub's tree against the last mirror commit, store the changed
 * bytes in R2, build the Lane head State and submit it as a normal Forge landing. */
export async function runInbound(
  ctx: ActionCtx,
  input: Identity,
  loaded: InboundBegin,
  states: (ids: string[]) => Promise<{ files: NativeFile[] }[]>,
) {
  if (loaded.phase === 'compose') return composeAndLand(ctx, input, loaded.owner, loaded.uploads ?? []);
  const mint = await installationTokenMinter(ctx, loaded.projectId, loaded.repository);
  const pull = loaded.pull;
  const token = await mint(pull ? pullCheckPermissions : inboundReadPermissions);
  const api = githubRequest(token);
  const prefix = `/repos/${loaded.repository}/git`;
  let commit: string;
  if (pull) {
    commit = pull.head;
    // A fork head's one pending status comes with its approve link, once its Lane exists.
    if (!pull.fork)
      await postPullStatus(api, loaded.repository, commit, 'pending', 'Forge check started.', loaded.link);
  } else {
    const ref = await api<{ object: { sha: string } }>(`${prefix}/ref/heads/main`);
    commit = ref.object.sha;
    if (commit === loaded.mapping.commit) {
      await ctx.runMutation(mutation('projectGithubInbound:adopt'), {
        ...input,
        commit,
        tree: loaded.mapping.tree,
      });
      return;
    }
  }
  const head = await api<{ tree: { sha: string }; message: string }>(`${prefix}/commits/${commit}`);
  const before = pull
    ? await pullBase(api, loaded.repository, loaded.mapping, commit)
    : { tree: loaded.mapping.tree, behind: null };
  const diff = await diffGithubTrees(api, loaded.repository, before.tree, head.tree.sha);
  if (before.behind) {
    // GitHub main moved since the PR branched: refuse paths both sides changed, never pick one.
    const main = new Map(before.behind.map(change => [change.path, change.after?.sha ?? null]));
    const both = diff.changes
      .filter(change => main.has(change.path) && main.get(change.path) !== (change.after?.sha ?? null))
      .map(change => change.path);
    if (both.length)
      throw new ForgeError(
        'GITHUB_PULL_BEHIND',
        `The PR and GitHub main both changed ${both.slice(0, 3).join(', ')}${both.length > 3 ? ` (+${both.length - 3})` : ''}; update the branch from main.`,
      );
  }
  if (!diff.changes.length) {
    if (pull) await ctx.runMutation(mutation('projectGithubPull:unchanged'), input);
    else
      await ctx.runMutation(mutation('projectGithubInbound:adopt'), {
        ...input,
        commit,
        tree: head.tree.sha,
      });
    return;
  }
  const same = loaded.mapping.state === loaded.base.head;
  const read = await states(same ? [loaded.base.head] : [loaded.mapping.state, loaded.base.head]);
  const equivalent = read[0]! as Parameters<typeof inboundConflicts>[0],
    base = (same ? read[0] : read[1])! as Parameters<typeof inboundConflicts>[1];
  const conflicts = inboundConflicts(equivalent, base, diff.changes);
  if (conflicts.length)
    throw new ForgeError(
      'GITHUB_INBOUND_CONFLICT',
      `GitHub changed paths Forge also changed before this push was mirrored: ${conflicts.slice(0, 5).join(', ')}${conflicts.length > 5 ? ` (+${conflicts.length - 5})` : ''}. Resolve on Forge, then resume this job.`,
    );
  // Bytes are read and stored one window at a time; only pins stay in memory. Git LFS
  // pointer files at LFS paths arrive as their objects (src/github-inbound-bytes.ts).
  const changed = diff.changes.filter(
    (change): change is InboundChange & { after: NonNullable<InboundChange['after']> } => !!change.after,
  );
  const touched = new Set(diff.changes.map(change => change.path));
  const applied = await bringInChanges(changed, {
    repository: loaded.repository,
    token,
    blob: sha => blob(api, loaded.repository, sha),
    unchangedAttributes: equivalent.files
      .map(file => file.path)
      .filter(path => isGitattributesPath(path) && !touched.has(path)),
    attributes: path => attributesAt(api, loaded.repository, commit, path),
    store: bytes => store(ctx, input, loaded.owner, bytes as Uint8Array[]),
    stored: digests =>
      ctx.runQuery(query('projectGithubInbound:storedObjects'), { ...input, digests }) as Promise<string[]>,
    bindRecipes: async recipes => {
      await ctx.runMutation(mutation('projectGithubInbound:bindRecipes'), { ...input, recipes });
    },
  });
  for (const change of diff.changes) if (!change.after) applied.push({ path: change.path, after: null });
  const at = new Date().toISOString();
  const lane = applyInbound(base as never, loaded.base.head, applied, head.message, at);
  const match = same
    ? lane
    : applyInbound(equivalent as never, loaded.mapping.state, applied, head.message, at);
  await store(ctx, input, loaded.owner, same ? [lane.bytes] : [lane.bytes, match.bytes]);
  const reply: { uploads: { value: string; pin: Pin }[] } = JSON.parse(
    await ctx.runMutation(mutation('projectGithubInbound:submit'), {
      ...input,
      commit,
      tree: head.tree.sha,
      message: head.message,
      head: lane.pin,
      equivalent: match.pin,
      changes: diff.changes.length,
      paths: diff.changes.slice(0, 20).map(change => change.path),
    }),
  );
  await composeAndLand(ctx, input, loaded.owner, reply.uploads);
}
/** The tree a PR's own changes start from: its merge base with the last mirrored GitHub main
 * (1 compare read), plus what main changed since then when the PR is behind (tree reads per
 * changed directory, as a push). A PR up to date with main diffs from main's tree directly. */
async function pullBase(
  api: GithubRequest,
  repository: string,
  mapping: { commit: string; tree: string },
  commit: string,
) {
  const compared = await api<{ merge_base_commit?: { sha?: string; commit?: { tree?: { sha?: string } } } }>(
    `/repos/${repository}/compare/${mapping.commit}...${commit}?per_page=1`,
  );
  const base = compared.merge_base_commit;
  invariant(
    typeof base?.sha === 'string' && typeof base.commit?.tree?.sha === 'string',
    'GITHUB_RESPONSE',
    'GitHub returned no merge base for this pull request.',
  );
  if (base.sha === mapping.commit) return { tree: mapping.tree, behind: null };
  const tree = base.commit.tree.sha;
  return { tree, behind: (await diffGithubTrees(api, repository, tree, mapping.tree)).changes };
}
async function composeAndLand(
  ctx: ActionCtx,
  input: Identity,
  owner: string,
  uploads: { value: string; pin: Pin }[],
) {
  await store(
    ctx,
    input,
    owner,
    uploads.map(upload => new TextEncoder().encode(upload.value)),
  );
  await ctx.runMutation(mutation('projectGithubInbound:land'), input);
}
