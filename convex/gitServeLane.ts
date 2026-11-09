// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { internalAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { projectSource } from './projectGithubMirror';
import { storeSourceBytes } from './projectSourceBytes';
import { convexFetch, networkTimeout } from './networkFetch';
import { presignGet, r2Config, r2Key } from './r2';
import { deleteR2Object } from './r2Operations';
import { historyChunkBytes } from './projectHistoryFields';
import { digest } from '../src/portable-hash';
import { invariant } from '../src/errors';
import type { NativeFile, NativeState } from '../src/native-state-format';
import { published } from '../src/hosted-github-mirror';
import { gitHash } from '../src/hosted-github-git';
import { gitlinkCommit } from '../src/gitlink';
import {
  formatLfsPointer,
  isGitattributesPath,
  isLfsPath,
  lfsPointerMaxBytes,
  lfsRules,
  parseLfsPointer,
  type LfsRule,
} from '../src/github-lfs';
import {
  laneCommitBytes,
  treeObjects,
  writePack,
  type GitEntry,
  type PackObject,
} from '../src/git-lane-objects';

/** Builds one Lane's Git commit (Issue 09367fb2) the way main's GitHub mirror writes main's:
 * the same published paths, LFS pointers and gitlinks, so the base tree must equal the tree
 * the mirror recorded for the parent commit (checked, never assumed). Bytes are read only for
 * blobs with no cached Git id and for blobs the parent commit lacks. */
type Alias = [sha1: string, size: number, gitlink: string, pointer: 0 | 1];
const window = 100,
  parallel = 16;
type Plan = {
  status: 'build';
  lane: { head: string; baseHead: string; baseReceiptId: string };
  parent: { commit: string; tree: string; legacy: boolean };
  author: { name: string; email: string };
  aliases: { sha256: string; size: number } | null;
};

async function readR2(projectId: string, sha256: string) {
  const response = await convexFetch(await presignGet(r2Config(), r2Key(projectId, sha256)), {
    redirect: 'error',
    signal: networkTimeout(30_000),
  });
  if (!response.ok) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  return digest(bytes) === sha256 ? bytes : null;
}
async function pool<T>(items: T[], run: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, worker));
}

export async function buildLane(ctx: ActionCtx, projectId: Id<'hostedProjects'>, laneId: string, plan: Plan) {
  const metric = { aliasesMissing: 0, readBytes: 0, resolveCalls: 0 };
  const source = projectSource(ctx, ids => {
    metric.resolveCalls++;
    return ctx.runQuery(internal.gitServeLaneStore.resolve, { projectId, digests: ids });
  });
  const stored = plan.aliases ? await readR2(projectId, plan.aliases.sha256) : null;
  const aliases = new Map<string, Alias>(stored ? Object.entries(JSON.parse(stored.toString('utf8'))) : []);
  const { lane, parent } = plan;
  const [base, head] = (await source.states([lane.baseHead, lane.head])) as [NativeState, NativeState];
  invariant(base && head, 'SOURCE_UNAVAILABLE', 'The Lane source States are unavailable.');
  const baseFiles = base.files.filter(published(parent.legacy ? 'legacy' : 'tracked'));
  const headFiles = head.files.filter(published('tracked'));

  // Reads blob bytes in windows of one query each; `keep` holds the bytes the pack needs.
  const read = async (blobs: string[], keep?: Map<string, Buffer>) => {
    for (let at = 0; at < blobs.length; at += window) {
      const ids = blobs.slice(at, at + window);
      const objects = await source.blobs(ids);
      await pool(
        ids.map((id, i) => ({ id, object: objects[i]! })),
        async ({ id, object }) => {
          const bytes = await object.read();
          metric.readBytes += bytes.length;
          let link = '';
          try {
            link = gitlinkCommit(bytes);
          } catch {}
          const pointer = bytes.length < lfsPointerMaxBytes && parseLfsPointer(bytes) ? 1 : 0;
          aliases.set(id, [gitHash('blob', bytes), bytes.length, link, pointer]);
          keep?.set(id, bytes);
        },
      );
    }
  };
  const used = [...new Set([...baseFiles, ...headFiles].map(file => file.blob))];
  const missing = used.filter(blob => !aliases.has(blob));
  metric.aliasesMissing = missing.length;
  await read(missing);
  // `.gitattributes` texts up to 1 MiB, as the mirror reads them; every other is empty.
  const attributes = new Map<string, string>();
  const attributeBlobs = [...baseFiles, ...headFiles]
    .filter(file => file.mode === 'file' && isGitattributesPath(file.path))
    .map(file => file.blob);
  const texts = new Map<string, Buffer>();
  await read(
    [...new Set(attributeBlobs)].filter(blob => aliases.get(blob)![1] <= 1024 * 1024),
    texts,
  );
  for (const [blob, bytes] of texts) attributes.set(blob, bytes.toString('utf8'));
  const rules = (files: NativeFile[]) =>
    lfsRules(
      files
        .filter(file => file.mode === 'file' && isGitattributesPath(file.path))
        .map(file => ({ path: file.path, text: attributes.get(file.blob) ?? '' })),
    );
  const lfsPath = (file: NativeFile, lfs: LfsRule[]) =>
    lfs.length > 0 && (file.mode === 'file' || file.mode === 'executable') && isLfsPath(lfs, file.path);
  const entries = (files: NativeFile[]) => {
    const lfs = rules(files);
    return files.map(file => {
      const [sha1, size, link, pointer] = aliases.get(file.blob)!;
      if (file.mode === 'gitlink') {
        invariant(link, 'INVALID_GITLINK', `${file.path} is not a valid submodule pointer.`);
        return { entry: { path: file.path, mode: file.mode, sha: link }, pointer: null };
      }
      if (lfsPath(file, lfs) && !pointer) {
        const bytes = formatLfsPointer({ oid: file.blob, size });
        return { entry: { path: file.path, mode: file.mode, sha: gitHash('blob', bytes) }, pointer: bytes };
      }
      return { entry: { path: file.path, mode: file.mode, sha: sha1 }, pointer: null };
    });
  };
  const baseEntries = entries(baseFiles);
  const baseTree = treeObjects(baseEntries.map(item => item.entry));
  invariant(
    baseTree.root === parent.tree,
    'GIT_LANE_TREE',
    `Forge's tree for this Lane's base differs from main's published Git commit ${parent.commit.slice(0, 12)}; no Lane ref was made.`,
  );
  const known = new Set<string>([...baseTree.trees.keys()]);
  for (const item of baseEntries) known.add(item.entry.sha);
  const headEntries = entries(headFiles);
  const tree = treeObjects(headEntries.map(item => item.entry as GitEntry));

  // The pack: the commit, the trees and the blobs the parent commit lacks.
  const objects: PackObject[] = [];
  let commit = parent.commit;
  let pack: { chunks: { sha256: string; size: number }[]; bytes: number; objects: number } | undefined;
  if (tree.root !== baseTree.root) {
    const commitBytes = laneCommitBytes({
      tree: tree.root,
      parent: parent.commit,
      author: plan.author,
      at: head.at,
      message: head.message,
      laneId,
      state: lane.head,
    });
    commit = gitHash('commit', commitBytes);
    objects.push({ type: 'commit', bytes: commitBytes });
    for (const [id, bytes] of tree.trees) if (!known.has(id)) objects.push({ type: 'tree', bytes });
    // Git blob id -> where its bytes come from (an LFS pointer, or the source object).
    const need = new Map<string, { pointer: Buffer | null; blob: string }>();
    headEntries.forEach((item, i) => {
      const sha = item.entry.sha;
      if (!known.has(sha) && !need.has(sha) && item.entry.mode !== 'gitlink')
        need.set(sha, { pointer: item.pointer, blob: headFiles[i]!.blob });
    });
    const contents = new Map<string, Buffer>();
    await read(
      [...new Set([...need.values()].filter(item => !item.pointer).map(item => item.blob))],
      contents,
    );
    for (const item of need.values())
      objects.push({ type: 'blob', bytes: item.pointer ?? contents.get(item.blob)! });
    const packBytes = writePack(objects);
    const chunks = [];
    for (let at = 0; at < packBytes.length; at += historyChunkBytes) {
      const part = packBytes.subarray(at, at + historyChunkBytes);
      const pin = { sha256: digest(part), size: part.length };
      await storeSourceBytes(ctx, projectId, part, pin);
      chunks.push(pin);
    }
    pack = { chunks, bytes: packBytes.length, objects: objects.length };
  }
  // Aliases of these two States only, so the object stays about two States in size.
  const kept = Object.fromEntries(used.map(blob => [blob, aliases.get(blob)!]));
  let aliasPin: { sha256: string; size: number } | undefined;
  if (metric.aliasesMissing || !plan.aliases) {
    const bytes = Buffer.from(JSON.stringify(kept));
    aliasPin = { sha256: digest(bytes), size: bytes.length };
    await storeSourceBytes(ctx, projectId, bytes, aliasPin);
  }
  const { discard } = await ctx.runMutation(internal.gitServeLaneStore.record, {
    projectId,
    laneId,
    head: lane.head,
    baseReceiptId: lane.baseReceiptId,
    commit,
    parent: parent.commit,
    ...(pack ? { pack } : {}),
    ...(aliasPin ? { aliases: aliasPin } : {}),
  });
  for (const sha256 of new Set(discard))
    await deleteR2Object(r2Config(), r2Key(projectId, sha256)).catch(() => {});
  console.log(
    `FORGE_GIT_LANE_METRIC ${JSON.stringify({ projectId, files: headFiles.length, objects: objects.length, packBytes: pack?.bytes ?? 0, ...metric })}`,
  );
  return commit;
}

/** One build per Lane head; a cached head returns at once. */
export const build = internalAction({
  args: { projectId: v.id('hostedProjects'), laneId: v.string() },
  returns: v.string(),
  handler: async (ctx, { projectId, laneId }): Promise<string> => {
    const plan = await ctx.runQuery(internal.gitServeLaneStore.plan, { projectId, laneId });
    if (plan.status === 'cached') return plan.commit as string;
    return buildLane(ctx, projectId, laneId, plan as Plan);
  },
});
