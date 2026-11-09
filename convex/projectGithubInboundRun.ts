// SPDX-License-Identifier: Apache-2.0
'use node';
import { convexFetch, networkTimeout } from './networkFetch';
import { makeFunctionReference } from 'convex/server';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { inboundReadPermissions, installationTokenMinter } from './githubAppToken';
import { commitObjects } from './projectObjectCommit';
import type { PreparedObject } from './projectObjects';
import { githubRequest, type GithubRequest } from '../src/hosted-github-api';
import { gitHash } from '../src/hosted-github-git';
import {
  applyInbound,
  diffGithubTrees,
  inboundBytes,
  inboundConflicts,
  type InboundChange,
} from '../src/github-inbound';
import type { NativeFile } from '../src/native-state-format';
import { digest } from '../src/portable-hash';
import { ForgeError, invariant } from '../src/errors';

const mutation = (name: string) => makeFunctionReference<'mutation'>(name);
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
  const api = githubRequest(await mint(inboundReadPermissions));
  const prefix = `/repos/${loaded.repository}/git`;
  const ref = await api<{ object: { sha: string } }>(`${prefix}/ref/heads/main`);
  const commit = ref.object.sha;
  if (commit === loaded.mapping.commit) {
    await ctx.runMutation(mutation('projectGithubInbound:adopt'), {
      ...input,
      commit,
      tree: loaded.mapping.tree,
    });
    return;
  }
  const head = await api<{ tree: { sha: string }; message: string }>(`${prefix}/commits/${commit}`);
  const diff = await diffGithubTrees(api, loaded.repository, loaded.mapping.tree, head.tree.sha);
  if (!diff.changes.length) {
    await ctx.runMutation(mutation('projectGithubInbound:adopt'), { ...input, commit, tree: head.tree.sha });
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
  // Bytes are read and stored one window at a time; only pins stay in memory.
  const applied: { path: string; after: { mode: NativeFile['mode']; blob: string } | null }[] = [];
  const changed = diff.changes.filter(
    (change): change is InboundChange & { after: object } => !!change.after,
  );
  for (let i = 0; i < changed.length; i += window) {
    const slice = changed.slice(i, i + window);
    const bytes = await Promise.all(
      slice.map(change =>
        inboundBytes(change.after!.mode, change.after!.sha, () =>
          blob(api, loaded.repository, change.after!.sha),
        ),
      ),
    );
    const pins = await store(ctx, input, loaded.owner, bytes);
    slice.forEach((change, j) =>
      applied.push({ path: change.path, after: { mode: change.after!.mode, blob: pins[j]!.sha256 } }),
    );
  }
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
