// SPDX-License-Identifier: Apache-2.0
import type { NativeFile } from './native-state-format.js';
import type { GithubFetch } from './github.js';
import type { InboundChange } from './github-inbound.js';
import { inboundBytes } from './github-inbound.js';
import { LfsImport } from './github-lfs-import.js';
import { ObjectRecipeBuilder } from './object-chunks.js';
import { digest } from './portable-hash.js';
import { lfsImportDefaultBytes } from './github-import-pages.js';
import { ForgeError } from './errors.js';

type Pin = { sha256: string; size: number };
export type InboundRecipe = { digest: string; size: number; recipeDigest: string; recipeSize: number };
export type InboundBytesIO = {
  repository: string;
  token?: string;
  request?: GithubFetch;
  /** Verified bytes of one GitHub blob (by Git object id). */
  blob(sha: string): Promise<Uint8Array>;
  /** `.gitattributes` files GitHub's new tree keeps that this push did not change. */
  unchangedAttributes: string[];
  attributes(path: string): Promise<string | null>;
  /** Stores new objects (prepare, PUT, commit windows) and returns their pins in order. */
  store(objects: Uint8Array[]): Promise<Pin[]>;
  /** Which of these oids the project already stores. */
  stored(oids: string[]): Promise<string[]>;
  bindRecipes(recipes: InboundRecipe[]): Promise<void>;
  /** Objects per upload window and bytes staged before a window is stored. */
  window?: number;
  stagedBytes?: number;
  now?: () => number;
};
export type InboundApplied = {
  path: string;
  after: { mode: NativeFile['mode']; blob: string } | null;
};
/** Wall time one inbound step may spend fetching LFS objects; a retry resumes from stored ones. */
export const inboundLfsMillis = 7 * 60_000;
const advice = {
  limit:
    'Push fewer or smaller LFS files at a time, or stop tracking them in Git LFS on GitHub, then resume this job.',
  missing:
    'Push the missing LFS object to GitHub, or stop tracking the file in Git LFS, then resume this job.',
};
const gitMode = (mode: NativeFile['mode']) => (mode === 'executable' ? '100755' : '100644');

/** The changed GitHub files as Forge bytes, stored one window at a time. Git LFS pointer
 * files at paths the new tree marks `filter=lfs` become their real objects through the
 * same resolver imports use (src/github-lfs-import.ts); GitHub is asked about LFS only
 * when a changed file is pointer-shaped, so a push without LFS makes no extra call. */
export async function bringInChanges(
  changes: readonly (InboundChange & { after: NonNullable<InboundChange['after']> })[],
  io: InboundBytesIO,
): Promise<InboundApplied[]> {
  const window = io.window ?? 99,
    now = io.now ?? Date.now,
    started = now();
  const lfs = new LfsImport(lfsImportDefaultBytes, { advice });
  const applied: InboundApplied[] = [];
  const modes = new Map<string, NativeFile['mode']>();
  for (let i = 0; i < changes.length; i += window) {
    const slice = changes.slice(i, i + window);
    const bytes = await Promise.all(
      slice.map(change => inboundBytes(change.after.mode, change.after.sha, () => io.blob(change.after.sha))),
    );
    const plain: number[] = [];
    slice.forEach((change, j) => {
      const { mode, sha } = change.after;
      const content = Buffer.from(bytes[j]!);
      // hold() reads changed .gitattributes and keeps back only valid pointer files.
      if (
        (mode === 'file' || mode === 'executable') &&
        lfs.hold({ path: change.path, mode: gitMode(mode), sha, size: content.length }, content)
      ) {
        modes.set(change.path, mode);
        return;
      }
      plain.push(j);
    });
    const pins = plain.length ? await io.store(plain.map(j => bytes[j]!)) : [];
    plain.forEach((j, k) =>
      applied.push({
        path: slice[j]!.path,
        after: { mode: slice[j]!.after.mode, blob: pins[k]!.sha256 },
      }),
    );
  }
  if (!lfs.holding) return applied;
  // Pointers are held: the attributes of the files this push did not touch decide which are LFS.
  for (const path of io.unchangedAttributes) {
    const text = await io.attributes(path);
    if (text !== null) lfs.addAttributes(path, text);
  }
  const staged = new Map<string, Buffer>();
  let stagedBytes = 0;
  const stageLimit = io.stagedBytes ?? 8 * 1024 * 1024;
  const stage = (bytes: Buffer) => {
    const pin = { sha256: digest(bytes), size: bytes.length };
    if (!staged.has(pin.sha256)) {
      staged.set(pin.sha256, Buffer.from(bytes));
      stagedBytes += bytes.length;
    }
    return pin;
  };
  const flush = async () => {
    if (!staged.size) return;
    const batch = [...staged.values()];
    staged.clear();
    stagedBytes = 0;
    await io.store(batch);
  };
  const recipes: InboundRecipe[] = [];
  let bound = 0,
    known = new Set<string>();
  await lfs.resolve({
    repository: io.repository,
    ...(io.token ? { token: io.token } : {}),
    ...(io.request ? { request: io.request } : {}),
    preload: async oids => {
      known = new Set();
      for (let i = 0; i < oids.length; i += window)
        for (const oid of await io.stored(oids.slice(i, i + window))) known.add(oid);
    },
    stored: oid => known.has(oid),
    put: bytes => {
      const pin = stage(bytes);
      return { sha256: pin.sha256, size: pin.size };
    },
    large: async (pointer, read) => {
      const builder = new ObjectRecipeBuilder(chunk => stage(chunk));
      await read(async part => {
        for (let offset = 0; offset < part.length; offset += 64 * 1024) {
          builder.update(part.subarray(offset, offset + 64 * 1024));
          if (stagedBytes >= stageLimit) await flush();
        }
      });
      const recipe = stage(builder.finish({ sha256: pointer.oid, size: pointer.size }).bytes);
      await flush();
      recipes.push({
        digest: pointer.oid,
        size: pointer.size,
        recipeDigest: recipe.sha256,
        recipeSize: recipe.size,
      });
    },
    record: (entry, pin) => {
      bound++;
      applied.push({ path: entry.path, after: { mode: modes.get(entry.path)!, blob: pin.blob } });
    },
    drain: flush,
    over: () => now() - started >= inboundLfsMillis,
  });
  await flush();
  for (let i = 0; i < recipes.length; i += window) await io.bindRecipes(recipes.slice(i, i + window));
  if (bound < modes.size)
    throw new ForgeError(
      'GITHUB_UNAVAILABLE',
      `Git LFS objects are still arriving (${bound} of ${modes.size} files bound). Resume this job; objects already stored are not fetched again.`,
    );
  return applied;
}
