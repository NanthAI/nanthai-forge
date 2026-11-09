// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { projectSource } from './projectGithubMirror';
import { storeSourceBytes } from './projectSourceBytes';
import { convexFetch, networkTimeout } from './networkFetch';
import { presignGet, r2Config, r2Key } from './r2';
import { historyChunkBytes } from './projectHistoryFields';
import { digest } from '../src/portable-hash';
import { invariant } from '../src/errors';
import type { NativeFile, NativeState } from '../src/native-state-format';
import { gitHash, gitMode } from '../src/hosted-github-git';
import { gitlinkCommit } from '../src/gitlink';
import { PackTrees, listTree, type TreeListing } from '../src/git-pack-trees';
import {
  formatLfsPointer,
  isGitattributesPath,
  isLfsPath,
  lfsPointerMaxBytes,
  lfsRules,
  parseLfsPointer,
  type LfsRule,
} from '../src/github-lfs';
import { treeObjects, writePack, type GitEntry, type PackObject } from '../src/git-lane-objects';

/** Git trees of Forge States, published the way main's GitHub mirror publishes main (the same
 * paths, LFS pointers and gitlinks). Shared by Lane refs (Issue 09367fb2) and Forge-built main
 * commits (Issue 3bd4a8e9). A base State's Git ids come from aliases or from its commit's tree
 * listing; a next State keeps every entry it did not change, so only changed files are read. */
export type Alias = [sha1: string, size: number, gitlink: string, pointer: 0 | 1];
export type Chunk = { sha256: string; size: number };
type Item = { entry: GitEntry; pointer: Buffer | null };
/** One State as a Git tree: its published files, LFS rules, entries and tree objects. */
export type TreeStep = {
  files: NativeFile[];
  rules: LfsRule[];
  items: Item[];
  tree: ReturnType<typeof treeObjects>;
};
const window = 100,
  parallel = 16;
/** Tree bytes one pack scan keeps; past it the scan gives up. */
export const treeBudget = 128 * 1024 * 1024;

export async function readR2(projectId: string, sha256: string) {
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
/** Feeds packs (each a list of R2 chunks, read one ahead) to `scan`, newest first, until `done`
 * says so after a chunk; false when a chunk is unreadable or the scan fails. */
export async function scanPacks(
  projectId: string,
  packs: Chunk[][],
  scan: PackTrees,
  done: () => boolean = () => false,
) {
  for (const chunks of packs) {
    scan.startPack();
    let next = chunks.length ? readR2(projectId, chunks[0]!.sha256) : null;
    for (let i = 0; i < chunks.length; i++) {
      const bytes = await next;
      next = i + 1 < chunks.length ? readR2(projectId, chunks[i + 1]!.sha256) : null;
      const ok = !!bytes && scan.push(bytes, i === chunks.length - 1);
      if (!ok || done()) {
        await next?.catch(() => null);
        return ok;
      }
    }
  }
  return true;
}
/** A commit tree's listing from the history packs, stopping once every tree under `root` is
 * found; null when a tree is missing, a chunk is unreadable or the scan passes its budget. */
export async function packListing(projectId: string, packs: Chunk[][], root: string) {
  const scan = new PackTrees(treeBudget);
  let listing: TreeListing | null = null;
  await scanPacks(projectId, packs, scan, () => !!(listing = listTree(scan, root)));
  return { listing, scanned: scan.scanned };
}
/** Stores a pack (objects, or its bytes) as content-addressed R2 chunks of at most
 * historyChunkBytes. */
export async function storePack(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  objects: PackObject[] | Buffer,
) {
  const bytes = Buffer.isBuffer(objects) ? objects : writePack(objects);
  const chunks: Chunk[] = [];
  for (let at = 0; at < bytes.length; at += historyChunkBytes) {
    const part = bytes.subarray(at, at + historyChunkBytes);
    const pin = { sha256: digest(part), size: part.length };
    await storeSourceBytes(ctx, projectId, part, pin);
    chunks.push(pin);
  }
  return {
    chunks,
    bytes: bytes.length,
    objects: bytes.readUInt32BE(8),
    packSha1: bytes.toString('hex', bytes.length - 20),
  };
}

export class TreeWork {
  readonly metric = { readBytes: 0, readBlobs: 0, resolveCalls: 0, listing: 0, packScanned: 0 };
  /** Bytes read that a pack may need (changed files and `.gitattributes`). */
  readonly contents = new Map<string, Buffer>();
  private readonly attributes = new Map<string, string>();
  readonly source: ReturnType<typeof projectSource>;
  constructor(
    ctx: ActionCtx,
    readonly projectId: Id<'hostedProjects'>,
    readonly aliases = new Map<string, Alias>(),
  ) {
    this.source = projectSource(ctx, ids => {
      this.metric.resolveCalls++;
      return ctx.runQuery(internal.gitServeLaneStore.resolve, { projectId, digests: ids });
    });
  }
  async states(ids: string[]) {
    const states = (await this.source.states(ids)) as NativeState[];
    invariant(
      states.every(state => state),
      'SOURCE_UNAVAILABLE',
      'The source States are unavailable.',
    );
    return states;
  }
  /** Reads blob bytes in windows of one query each, recording their aliases; `keep` holds the
   * bytes and `small` reads only blobs up to that size. */
  async read(blobs: string[], keep?: Map<string, Buffer>, small?: number) {
    for (let at = 0; at < blobs.length; at += window) {
      const ids = blobs.slice(at, at + window);
      const objects = await this.source.blobs(ids);
      await pool(
        ids.map((id, i) => ({ id, object: objects[i]! })).filter(item => !small || item.object.size <= small),
        async ({ id, object }) => {
          const bytes = await object.read();
          this.metric.readBytes += bytes.length;
          this.metric.readBlobs++;
          let link = '';
          try {
            link = gitlinkCommit(bytes);
          } catch {}
          const pointer = bytes.length < lfsPointerMaxBytes && parseLfsPointer(bytes) ? 1 : 0;
          this.aliases.set(id, [gitHash('blob', bytes), bytes.length, link, pointer]);
          keep?.set(id, bytes);
        },
      );
    }
  }
  /** `.gitattributes` texts up to 1 MiB, as the mirror reads them; every other is empty. */
  private async rules(files: NativeFile[]) {
    const attributes = files.filter(file => file.mode === 'file' && isGitattributesPath(file.path));
    const missing = [...new Set(attributes.map(file => file.blob))].filter(
      blob => !this.attributes.has(blob),
    );
    const texts = new Map<string, Buffer>();
    await this.read(missing, texts, 1024 * 1024);
    for (const blob of missing) {
      const bytes = texts.get(blob);
      this.attributes.set(blob, bytes ? bytes.toString('utf8') : '');
      if (bytes) this.contents.set(blob, bytes);
    }
    return lfsRules(attributes.map(file => ({ path: file.path, text: this.attributes.get(file.blob)! })));
  }
  private lfsPath(file: NativeFile, lfs: LfsRule[]) {
    return (
      lfs.length > 0 && (file.mode === 'file' || file.mode === 'executable') && isLfsPath(lfs, file.path)
    );
  }
  /** An alias answers a file when it has what that file's entry uses: the gitlink commit, the
   * size of an LFS path, else the blob id (aliases taken from a tree listing have no size). */
  private unknown(files: NativeFile[], lfs: LfsRule[]) {
    const answers = (file: NativeFile) => {
      const alias = this.aliases.get(file.blob);
      if (!alias) return false;
      if (file.mode === 'gitlink') return !!alias[2];
      return this.lfsPath(file, lfs) ? alias[1] >= 0 : !!alias[0];
    };
    return [...new Set(files.filter(file => !answers(file)).map(file => file.blob))];
  }
  private entry(file: NativeFile, lfs: LfsRule[]): Item {
    const [sha1, size, link, pointer] = this.aliases.get(file.blob)!;
    if (file.mode === 'gitlink') {
      invariant(link, 'INVALID_GITLINK', `${file.path} is not a valid submodule pointer.`);
      return { entry: { path: file.path, mode: file.mode, sha: link }, pointer: null };
    }
    if (this.lfsPath(file, lfs) && !pointer) {
      const bytes = formatLfsPointer({ oid: file.blob, size });
      return { entry: { path: file.path, mode: file.mode, sha: gitHash('blob', bytes) }, pointer: bytes };
    }
    return { entry: { path: file.path, mode: file.mode, sha: sha1 }, pointer: null };
  }
  /** `files` as the commit tree `root`. Ids come from `listing` (checked against the files'
   * paths and modes), else from aliases (reading unknown blobs); `scan` is asked for a listing
   * when more than `threshold` blobs are unknown. Throws `code` unless the tree is `root`. */
  async base(
    files: NativeFile[],
    root: string,
    options: {
      listing?: TreeListing | null;
      scan?: () => Promise<TreeListing | null>;
      threshold?: number;
      code: string;
      message: string;
    },
  ): Promise<TreeStep> {
    const rules = await this.rules(files);
    const missing = this.unknown(files, rules);
    let listing = options.listing ?? null;
    if (!listing && options.scan && missing.length > (options.threshold ?? 0)) listing = await options.scan();
    if (
      listing &&
      !(
        listing.size === files.length &&
        files.every(file => listing!.get(file.path)?.mode === gitMode(file.mode))
      )
    )
      listing = null;
    if (listing) {
      this.metric.listing = 1;
      for (const file of files)
        if (file.mode !== 'gitlink' && !this.lfsPath(file, rules) && !this.aliases.has(file.blob))
          this.aliases.set(file.blob, [listing.get(file.path)!.sha, -1, '', 0]);
    } else await this.read(missing);
    const items = files.map(file =>
      listing
        ? { entry: { path: file.path, mode: file.mode, sha: listing.get(file.path)!.sha }, pointer: null }
        : this.entry(file, rules),
    );
    const tree = treeObjects(items.map(item => item.entry));
    invariant(tree.root === root, options.code, options.message);
    return { files, rules, items, tree };
  }
  /** The next State's tree: a file left as it was (same blob, mode and LFS rule) keeps its
   * entry from `prev`; changed files are read unless an alias answers them. */
  async next(prev: TreeStep, files: NativeFile[]): Promise<TreeStep> {
    const rules = await this.rules(files);
    const before = new Map(prev.files.map((file, i) => [file.path, { file, entry: prev.items[i]!.entry }]));
    const unchanged = (file: NativeFile) => {
      const old = before.get(file.path);
      return old &&
        old.file.blob === file.blob &&
        old.file.mode === file.mode &&
        this.lfsPath(old.file, prev.rules) === this.lfsPath(file, rules)
        ? old.entry
        : null;
    };
    await this.read(
      this.unknown(
        files.filter(file => !unchanged(file)),
        rules,
      ),
      this.contents,
    );
    const items = files.map(file => {
      const same = unchanged(file);
      return same ? { entry: same, pointer: null } : this.entry(file, rules);
    });
    return { files, rules, items, tree: treeObjects(items.map(item => item.entry)) };
  }
  /** Trees and blobs of `step` not in `known` (which then holds them): the objects a pack of
   * this commit adds. Reads blob bytes not read yet. */
  async objects(step: TreeStep, known: Set<string>) {
    const objects: PackObject[] = [];
    for (const [id, bytes] of step.tree.trees)
      if (!known.has(id)) {
        known.add(id);
        objects.push({ type: 'tree', bytes });
      }
    // Git blob id -> where its bytes come from (an LFS pointer, or the source object).
    const need = new Map<string, { pointer: Buffer | null; blob: string }>();
    step.items.forEach((item, i) => {
      const sha = item.entry.sha;
      if (!known.has(sha) && !need.has(sha) && item.entry.mode !== 'gitlink')
        need.set(sha, { pointer: item.pointer, blob: step.files[i]!.blob });
    });
    const unread = [...need.values()].filter(item => !item.pointer && !this.contents.has(item.blob));
    await this.read([...new Set(unread.map(item => item.blob))], this.contents);
    for (const [sha, item] of need) {
      known.add(sha);
      objects.push({ type: 'blob', bytes: item.pointer ?? this.contents.get(item.blob)! });
    }
    return objects;
  }
}
/** Every id a step's tree holds: its trees and entries. */
export function stepIds(step: TreeStep) {
  return new Set<string>([...step.tree.trees.keys(), ...step.items.map(item => item.entry.sha)]);
}
