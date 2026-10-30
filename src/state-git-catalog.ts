// SPDX-License-Identifier: Apache-2.0
import { deflateSync, inflateSync } from 'node:zlib';
import { z } from 'zod';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import type { ObjectStore } from './hosted-object-store.js';
import { oid } from './native-state-format.js';
import { readGitPack, writeGitPack } from './state-git-pack.js';
import {
  emptyStateGitCache,
  gitToState,
  stateToGit,
  type GitObject,
  type StateGitConversion,
  type StateGitRecord,
} from './state-git.js';

/** P5-SG storage: each save writes at most one Git pack of its new trees and
 * one catalog page. A page names the packs back to the latest snapshot (a save
 * whose pack holds every tree of its State), so a reader needs the page, the
 * snapshot page and at most STATE_GIT_CHAIN packs: no Convex call. File bytes
 * stay single-copy under their SHA-256 IDs; the page aliases map Git blob IDs
 * to them, so rebuilding a State never downloads file contents. */
export const STATE_GIT_CHAIN = 16;
/** A delta page repeats every alias introduced since its snapshot; past this a
 * new snapshot is cheaper to read than ever-growing delta pages. */
export const STATE_GIT_DELTA_ALIASES = 512;
const MAX_PAGE_BYTES = 64 * 1024 * 1024;

const gitOid = z.string().regex(/^[0-9a-f]{40}$/);
const pageSchema = z
  .object({
    schema: z.literal(1),
    kind: z.literal('forge-git-page'),
    record: z
      .object({
        schema: z.literal(1),
        kind: z.literal('forge-git-state'),
        state: oid,
        tree: gitOid,
        fields: z.record(z.string(), z.unknown()),
        filesAt: z.number().int().min(0),
        gitlinks: z.record(z.string(), oid).optional(),
      })
      .strict(),
    /** Pack object IDs to read, snapshot pack first. */
    packs: z.array(oid).min(1).max(STATE_GIT_CHAIN),
    /** The snapshot page; absent when this page is the snapshot. */
    snapshot: oid.optional(),
    /** Git blob oid → SHA-256 blob. A snapshot holds every blob of its State;
     * a delta holds every blob introduced since its snapshot. */
    aliases: z.record(gitOid, oid),
  })
  .strict();
export type StateGitPage = z.infer<typeof pageSchema>;
/** A verified page with everything needed to read its State or extend it.
 * Trees and aliases are exactly the page's chain, never a sibling's. */
export type LoadedStateGit = {
  page: string;
  value: StateGitPage;
  /** The snapshot page (this page when it is the snapshot). */
  snapshot: { page: string; value: StateGitPage };
  /** Trees of each pack in `value.packs`. */
  packs: Map<string, Map<string, GitObject>>;
  /** Every tree in the chain's packs. */
  objects: Map<string, GitObject>;
  /** Snapshot plus delta aliases. */
  aliases: Map<string, string>;
  /** The exact manifest bytes; they hash to `value.record.state`. */
  manifest: Buffer;
};
export type StateGitWrite =
  | Extract<StateGitConversion, { exact: false }>
  | { exact: true; loaded: LoadedStateGit; puts: number };

/** Store one save. `base` (normally the first parent's page) lets the pack hold
 * only the trees its chain lacks; `readBlob` is called once per file new to that
 * chain. A non-canonical manifest writes nothing. */
export async function writeStateGit(
  store: Pick<ObjectStore, 'put'>,
  manifest: Uint8Array,
  readBlob: (blob: string) => Uint8Array,
  base?: LoadedStateGit,
): Promise<StateGitWrite> {
  const cache = emptyStateGitCache();
  for (const [git, blob] of base?.aliases ?? []) {
    cache.aliases.set(git, blob);
    cache.blobs.set(blob, git);
  }
  for (const id of base?.objects.keys() ?? []) cache.stored.add(id);
  const result = stateToGit(manifest, readBlob, cache);
  if (!result.exact) return result;
  const fresh: Record<string, string> = base?.value.snapshot ? { ...base.value.aliases } : {};
  for (const [id, object] of result.objects) if (object.type === 'blob') fresh[id] = cache.aliases.get(id)!;
  const delta =
    base && base.value.packs.length < STATE_GIT_CHAIN && Object.keys(fresh).length <= STATE_GIT_DELTA_ALIASES;
  let packed = new Map([...result.objects].filter(([, object]) => object.type === 'tree')),
    aliases = fresh;
  if (!delta) {
    const fresher = packed;
    packed = new Map();
    collectTrees(result.record.tree, id => fresher.get(id) ?? base?.objects.get(id), packed);
    aliases = {};
    for (const file of JSON.parse(Buffer.from(manifest).toString('utf8')).files as {
      blob: string;
      mode: string;
    }[])
      if (file.mode !== 'gitlink') aliases[cache.blobs.get(file.blob)!] = file.blob;
  }
  let puts = 0;
  const packs = new Map(delta ? base.packs : []);
  if (packed.size) {
    packs.set(await store.put(writeGitPack(packed.values())), packed);
    puts++;
  }
  const value: StateGitPage = {
    schema: 1,
    kind: 'forge-git-page',
    record: result.record,
    packs: [...packs.keys()],
    ...(delta ? { snapshot: base.snapshot.page } : {}),
    aliases: Object.fromEntries(Object.entries(aliases).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
  const page = await store.put(deflateSync(JSON.stringify(value)));
  puts++;
  return {
    exact: true,
    puts,
    loaded: {
      page,
      value,
      snapshot: delta ? base.snapshot : { page, value },
      packs,
      objects: delta ? new Map([...base.objects, ...packed]) : packed,
      aliases: delta ? cache.aliases : new Map(Object.entries(aliases)),
      manifest: Buffer.from(manifest),
    },
  };
}

/** Add every tree reachable from `id` (all of them already known) to `into`. */
function collectTrees(
  id: string,
  known: (id: string) => GitObject | undefined,
  into: Map<string, GitObject>,
) {
  if (into.has(id)) return;
  const tree = known(id);
  invariant(tree?.type === 'tree', 'SOURCE_UNAVAILABLE', 'A Git tree of the State is missing.');
  into.set(id, tree);
  const bytes = tree.bytes;
  for (let at = 0; at < bytes.length;) {
    const nul = bytes.indexOf(0, at);
    if (bytes.subarray(at, bytes.indexOf(0x20, at)).toString('latin1') === '40000')
      collectTrees(bytes.subarray(nul + 1, nul + 21).toString('hex'), known, into);
    at = nul + 21;
  }
}

/** Read a page, its snapshot page and its packs (two parallel rounds), verify
 * them and rebuild the exact manifest, which must hash to the State. `known`
 * (for example the parent's chain) skips the snapshot and packs it already holds. */
export async function readStateGit(
  store: Pick<ObjectStore, 'get'>,
  page: string,
  known?: LoadedStateGit,
): Promise<LoadedStateGit> {
  const value = parsePage(await fetch(store, page)),
    snapshotPage = value.snapshot ?? page,
    reuse = known?.snapshot.page === snapshotPage ? known : undefined;
  const [snapshotValue, ...fetched] = await Promise.all([
    !value.snapshot ? value : (reuse?.snapshot.value ?? fetch(store, snapshotPage).then(parsePage)),
    ...value.packs.map(async id => reuse?.packs.get(id) ?? trees(await fetch(store, id))),
  ]);
  invariant(
    !snapshotValue.snapshot && snapshotValue.packs.length === 1 && snapshotValue.packs[0] === value.packs[0],
    'GIT_OBJECT_INVALID',
    'A Git catalog page does not match its snapshot.',
  );
  const packs = new Map(value.packs.map((id, index) => [id, fetched[index]!])),
    objects = new Map([...packs.values()].flatMap(pack => [...pack])),
    aliases = new Map(
      Object.entries(value.snapshot ? { ...snapshotValue.aliases, ...value.aliases } : value.aliases),
    );
  const manifest = gitToState(
    value.record as StateGitRecord,
    id => {
      const tree = objects.get(id);
      invariant(tree, 'SOURCE_UNAVAILABLE', 'A Git tree of the State is missing.');
      return tree.bytes;
    },
    id => aliases.get(id),
  );
  return {
    page,
    value,
    snapshot: { page: snapshotPage, value: snapshotValue },
    packs,
    objects,
    aliases,
    manifest,
  };
}

function trees(pack: Buffer) {
  const objects = readGitPack(pack);
  for (const object of objects.values())
    invariant(object.type === 'tree', 'GIT_OBJECT_INVALID', 'A State pack holds only trees.');
  return objects;
}
async function fetch(store: Pick<ObjectStore, 'get'>, id: string) {
  const bytes = await store.get(id);
  invariant(digest(bytes) === id, 'SOURCE_HASH_MISMATCH', 'A stored object differs from its pin.');
  return bytes;
}
function parsePage(bytes: Buffer): StateGitPage {
  let value: unknown;
  try {
    value = JSON.parse(inflateSync(bytes, { maxOutputLength: MAX_PAGE_BYTES }).toString('utf8'));
  } catch {
    value = undefined;
  }
  const parsed = pageSchema.safeParse(value);
  invariant(parsed.success, 'GIT_OBJECT_INVALID', 'A Git catalog page is invalid.');
  return parsed.data;
}
