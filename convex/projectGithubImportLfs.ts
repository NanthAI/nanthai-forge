// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';
import type { GithubFetch } from '../src/github';
import { githubSourceMode, type GithubSourceEntry } from '../src/github-project-source';
import { lfsImportDefaultBytes, filePage, type ImportProgress } from '../src/github-import-pages';
import { LfsImport } from '../src/github-lfs-import';
import { ObjectRecipeBuilder } from '../src/object-chunks';
import { ForgeError } from '../src/errors';
import type { ImportUpload } from './projectGithubImportUpload';

type Row = { part: string; key: string; position: number; value: string };
/** Wall time one paged-import run may spend fetching LFS objects; the next run resumes
 * from the objects already stored. */
export const pagedLfsMillis = 8 * 60_000;
/** Paged imports resolve LFS per page; the limit counts unique bytes across pages. */
export const pagedLfs = (progress: ImportProgress) =>
  new LfsImport(progress.lfsLimitBytes ?? lfsImportDefaultBytes, {
    carried: progress.lfsBytes ?? 0,
    skipStored: true,
  });

/** Binds the pointer-shaped files of one page after reading every `.gitattributes` the
 * listing saw (they ride in the cursor), so an LFS path is decided only once all rules are
 * known. Rows after the first unresolved file are dropped so the next run takes them up
 * again; stored objects are never fetched twice. Returns the rows and bytes kept. */
export async function resolvePageLfs(
  ctx: ActionCtx,
  input: {
    job: Doc<'projectGithubImports'>;
    progress: ImportProgress;
    lfs: LfsImport;
    upload: ImportUpload;
    held: Map<string, { at: number; file: GithubSourceEntry }>;
    imported: Row[];
    sizes: number[];
    token?: string;
    github: GithubFetch;
    fetchAttributes: (entries: GithubSourceEntry[]) => Promise<Map<string, Buffer>>;
    started: number;
    actor: string;
  },
) {
  const { job, progress, lfs, upload, held, imported, sizes } = input;
  const attributes = progress.attributes ?? [];
  for (let at = 0; at < attributes.length;) {
    const page = filePage(attributes.slice(at).map(entry => ({ ...entry, mode: '100644' as const })));
    const blobs = await input.fetchAttributes(page);
    for (const entry of page) lfs.addAttributes(entry.path, blobs.get(entry.sha)!.toString('utf8'));
    at += page.length;
  }
  let known = new Set<string>();
  const resolved = new Set<string>();
  await lfs.resolve({
    repository: job.repository,
    ...(input.token ? { token: input.token } : {}),
    request: input.github,
    preload: async oids => {
      known = new Set();
      for (let i = 0; i < oids.length; i += 100)
        for (const oid of await ctx.runQuery(internal.projectGithubImportBatch.stored, {
          projectId: job.projectId,
          actor: input.actor,
          digests: oids.slice(i, i + 100),
        }))
          known.add(oid);
    },
    stored: oid => known.has(oid),
    put: upload.put,
    large: async (pointer, read) => {
      const builder = new ObjectRecipeBuilder(upload.put);
      await read(async part => {
        for (let offset = 0; offset < part.length; offset += 64 * 1024) {
          builder.update(part.subarray(offset, offset + 64 * 1024));
          if (await upload.drain()) await upload.commit();
        }
      });
      upload.recipe(
        { blob: pointer.oid, size: pointer.size },
        builder.finish({ sha256: pointer.oid, size: pointer.size }).bytes,
      );
    },
    record: (entry, pin) => {
      const row = held.get(entry.path)!;
      imported[row.at]!.value = JSON.stringify({
        path: entry.path,
        blob: pin.blob,
        size: pin.size,
        mode: githubSourceMode(entry.mode),
      });
      sizes[row.at] = pin.size;
      resolved.add(entry.path);
    },
    drain: async () => {
      if (await upload.drain()) await upload.commit();
    },
    over: () => Date.now() - input.started >= pagedLfsMillis,
  });
  // The first unresolved pointer ends this page's rows; later rows are retaken next run.
  const first = Math.min(
    imported.length,
    ...[...held].filter(([path]) => !resolved.has(path)).map(([, row]) => row.at),
  );
  if (first === 0 && held.size)
    throw new ForgeError(
      'GITHUB_UNAVAILABLE',
      'Git LFS objects did not arrive within the run. Retry resumes from the objects already stored.',
    );
  imported.length = first;
  sizes.length = first;
  progress.after = imported.at(-1)?.key ?? progress.after;
  progress.lfsBytes = (progress.lfsBytes ?? 0) + lfs.fetchedBytes;
  return { rows: first, bytes: sizes.reduce((sum, size) => sum + size, 0) };
}
