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
import { gitHash, gitMode } from '../src/hosted-github-git';
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
import { PackTrees, listTree, type TreeListing } from '../src/git-pack-trees';
import {
  laneCommitBytes,
  treeObjects,
  writePack,
  type GitEntry,
  type PackObject,
} from '../src/git-lane-objects';

/** Builds one Lane's Git commit (Issue 09367fb2) the way main's GitHub mirror writes main's:
 * the same published paths, LFS pointers and gitlinks, so the base tree must equal the tree
 * the mirror recorded for the parent commit (checked, never assumed). Git ids come from the
 * alias object, else from the parent commit's trees in the stored history packs (Issue
 * 3bd4a8e9); bytes are read only for blobs the Lane changed and blobs neither knows. */
type Alias = [sha1: string, size: number, gitlink: string, pointer: 0 | 1];
const window = 100,
  parallel = 16;
/** Base blobs missing from the alias object past which the parent's trees are read from the
 * history packs instead of the files. */
export const listingThreshold = 32;
/** Tree bytes one pack scan keeps; past it the build reads files instead. */
const treeBudget = 128 * 1024 * 1024;
type Chunk = { sha256: string; size: number };
type Plan = {
  status: 'build';
  lane: { head: string; baseHead: string; baseReceiptId: string };
  parent: { commit: string; tree: string; legacy: boolean };
  author: { name: string; email: string };
  aliases: Chunk | null;
  /** History packs' chunks, newest pack first. */
  packs?: Chunk[][];
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
/** The parent commit's tree listing from the history packs, newest pack first, stopping once
 * every tree under `root` is found; null when a tree is missing, a chunk is unreadable or the
 * scan passes its budget. Chunks of one pack are read ahead one at a time. */
export async function packListing(projectId: string, packs: Chunk[][], root: string) {
  const scan = new PackTrees(treeBudget);
  for (const chunks of packs) {
    scan.startPack();
    let next = chunks.length ? readR2(projectId, chunks[0]!.sha256) : null;
    for (let i = 0; i < chunks.length; i++) {
      const bytes = await next;
      next = i + 1 < chunks.length ? readR2(projectId, chunks[i + 1]!.sha256) : null;
      if (!bytes || !scan.push(bytes, i === chunks.length - 1)) {
        await next?.catch(() => null);
        return { listing: null, scanned: scan.scanned };
      }
      const listing = listTree(scan, root);
      if (listing) {
        await next?.catch(() => null);
        return { listing, scanned: scan.scanned };
      }
    }
  }
  return { listing: null, scanned: scan.scanned };
}

export async function buildLane(ctx: ActionCtx, projectId: Id<'hostedProjects'>, laneId: string, plan: Plan) {
  const started = Date.now();
  const metric = {
    aliasesMissing: 0,
    readBytes: 0,
    readBlobs: 0,
    resolveCalls: 0,
    listing: 0,
    packScanned: 0,
  };
  const source = projectSource(ctx, ids => {
    metric.resolveCalls++;
    return ctx.runQuery(internal.gitServeLaneStore.resolve, { projectId, digests: ids });
  });
  const stored = plan.aliases ? await readR2(projectId, plan.aliases.sha256) : null;
  const storedAliases = new Map<string, Alias>(
    stored ? Object.entries(JSON.parse(stored.toString('utf8'))) : [],
  );
  const aliases = new Map(storedAliases);
  const { lane, parent } = plan;
  const [base, head] = (await source.states([lane.baseHead, lane.head])) as [NativeState, NativeState];
  invariant(base && head, 'SOURCE_UNAVAILABLE', 'The Lane source States are unavailable.');
  const baseFiles = base.files.filter(published(parent.legacy ? 'legacy' : 'tracked'));
  const headFiles = head.files.filter(published('tracked'));

  // Reads blob bytes in windows of one query each; `keep` holds the bytes the pack needs and
  // `small` reads only blobs up to that size.
  const read = async (blobs: string[], keep?: Map<string, Buffer>, small?: number) => {
    for (let at = 0; at < blobs.length; at += window) {
      const ids = blobs.slice(at, at + window);
      const objects = await source.blobs(ids);
      await pool(
        ids.map((id, i) => ({ id, object: objects[i]! })).filter(item => !small || item.object.size <= small),
        async ({ id, object }) => {
          const bytes = await object.read();
          metric.readBytes += bytes.length;
          metric.readBlobs++;
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
  // `.gitattributes` texts up to 1 MiB, as the mirror reads them; every other is empty.
  const attributes = new Map<string, string>();
  const attributeBlobs = [...baseFiles, ...headFiles]
    .filter(file => file.mode === 'file' && isGitattributesPath(file.path))
    .map(file => file.blob);
  const contents = new Map<string, Buffer>();
  await read([...new Set(attributeBlobs)], contents, 1024 * 1024);
  for (const [blob, bytes] of contents) attributes.set(blob, bytes.toString('utf8'));
  const rules = (files: NativeFile[]) =>
    lfsRules(
      files
        .filter(file => file.mode === 'file' && isGitattributesPath(file.path))
        .map(file => ({ path: file.path, text: attributes.get(file.blob) ?? '' })),
    );
  const lfsPath = (file: NativeFile, lfs: LfsRule[]) =>
    lfs.length > 0 && (file.mode === 'file' || file.mode === 'executable') && isLfsPath(lfs, file.path);
  const baseRules = rules(baseFiles),
    headRules = rules(headFiles);
  // An alias answers a file when it has what that file's entry uses: the gitlink commit, the
  // size of an LFS path, else the blob id (aliases taken from a tree listing have no size).
  const answers = (file: NativeFile, lfs: LfsRule[]) => {
    const alias = aliases.get(file.blob);
    if (!alias) return false;
    if (file.mode === 'gitlink') return !!alias[2];
    return lfsPath(file, lfs) ? alias[1] >= 0 : !!alias[0];
  };
  const unknown = (files: NativeFile[], lfs: LfsRule[]) => [
    ...new Set(files.filter(file => !answers(file, lfs)).map(file => file.blob)),
  ];
  const baseMissing = unknown(baseFiles, baseRules);
  metric.aliasesMissing = baseMissing.length;

  // Many unknown base blobs (a first build): list the parent commit's tree from the packs.
  let listing: TreeListing | null = null;
  if (baseMissing.length > listingThreshold && plan.packs?.length) {
    const found = await packListing(projectId, plan.packs, parent.tree);
    metric.packScanned = found.scanned;
    const candidate = found.listing;
    if (
      candidate &&
      candidate.size === baseFiles.length &&
      baseFiles.every(file => candidate.get(file.path)?.mode === gitMode(file.mode))
    )
      listing = candidate;
  }
  if (listing) {
    metric.listing = 1;
    for (const file of baseFiles)
      if (file.mode !== 'gitlink' && !lfsPath(file, baseRules) && !aliases.has(file.blob))
        aliases.set(file.blob, [listing.get(file.path)!.sha, -1, '', 0]);
  } else await read(baseMissing);

  type Item = { entry: GitEntry; pointer: Buffer | null };
  const entry = (file: NativeFile, lfs: LfsRule[]): Item => {
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
  };
  const baseEntries = baseFiles.map(file =>
    listing
      ? { entry: { path: file.path, mode: file.mode, sha: listing.get(file.path)!.sha }, pointer: null }
      : entry(file, baseRules),
  );
  const baseTree = treeObjects(baseEntries.map(item => item.entry));
  invariant(
    baseTree.root === parent.tree,
    'GIT_LANE_TREE',
    `Forge's tree for this Lane's base differs from main's published Git commit ${parent.commit.slice(0, 12)}; no Lane ref was made.`,
  );
  const known = new Set<string>([...baseTree.trees.keys()]);
  for (const item of baseEntries) known.add(item.entry.sha);
  // A head file the Lane left as it was (same blob, mode and LFS rule) keeps its base entry.
  const baseByPath = new Map(baseFiles.map((file, i) => [file.path, { file, entry: baseEntries[i]!.entry }]));
  const unchanged = (file: NativeFile) => {
    const before = baseByPath.get(file.path);
    return before &&
      before.file.blob === file.blob &&
      before.file.mode === file.mode &&
      lfsPath(before.file, baseRules) === lfsPath(file, headRules)
      ? before.entry
      : null;
  };
  const changed = headFiles.filter(file => !unchanged(file));
  await read(unknown(changed, headRules), contents);
  const headEntries = headFiles.map(file => {
    const same = unchanged(file);
    return same ? { entry: same, pointer: null } : entry(file, headRules);
  });
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
    await read(
      [
        ...new Set(
          [...need.values()].filter(item => !item.pointer && !contents.has(item.blob)).map(item => item.blob),
        ),
      ],
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
  const used = [...new Set([...baseFiles, ...headFiles].map(file => file.blob))].filter(blob =>
    aliases.has(blob),
  );
  const kept = Object.fromEntries(used.map(blob => [blob, aliases.get(blob)!]));
  let aliasPin: { sha256: string; size: number } | undefined;
  if (!plan.aliases || used.some(blob => storedAliases.get(blob)?.join() !== aliases.get(blob)!.join())) {
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
    `FORGE_GIT_LANE_METRIC ${JSON.stringify({ projectId, files: headFiles.length, objects: objects.length, packBytes: pack?.bytes ?? 0, ms: Date.now() - started, ...metric })}`,
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
