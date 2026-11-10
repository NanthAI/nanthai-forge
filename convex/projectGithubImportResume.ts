// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { r2Config, r2Key, presignGet } from './r2';
import { exchangeFetch } from '../src/exchange-request';
import { ForgeError, invariant } from '../src/errors';
import { digest } from '../src/hash';
import { objectRecipeSchema, readObjectRecipe, type ChunkPin } from '../src/object-chunks';
import { packHeaders, packRange, verifyPackRange } from '../src/object-pack-range';
import { CatalogTable } from '../src/import-catalog-table';
import { ImportedPins } from '../src/github-listing-codec';
import { importStateFiles } from '../src/import-state-scan';
import type { ImportRequestMeter } from '../src/github-import-meter';
import { windowEntries } from './projectGithubImportCatalog';
import type { CatalogEntry } from './projectGithubImportUpload';
import { publishImport, type ImportRows } from './projectGithubImportPublish';
import { dropListing } from './projectGithubImportListing';

type Identity = { id: Id<'projectGithubImports'>; actor: string };

/** Progress of an archive import is the objects its windows stored: one receipt per window. */
export async function storedObjects(ctx: ActionCtx, input: Identity) {
  const stored = new CatalogTable();
  for (let after = ''; ;) {
    const rows = await ctx.runQuery(internal.projectGithubImportCatalog.stored, { ...input, after });
    if (!rows.length) break;
    for (const row of rows) for (const entry of windowEntries(row.value)) stored.set(entry.digest, entry);
    after = rows.at(-1)!.key;
  }
  return stored;
}

/** One stored object, read back from R2 (a raw object, or one range of its pack) and verified. */
async function rawBytes(projectId: Id<'hostedProjects'>, stored: CatalogTable, pin: ChunkPin) {
  const entry = stored.get(pin.sha256);
  invariant(
    entry && !entry.recipe && entry.size === pin.size,
    'INVALID_WORK_BACKUP',
    'A stored source object is missing.',
  );
  const range = packRange(entry),
    headers = packHeaders(range, pin.size);
  const url = await presignGet(r2Config(), r2Key(projectId, entry.pack?.digest ?? pin.sha256), headers);
  const response = await exchangeFetch('R2 import resume read', url, {
    headers: { 'accept-encoding': 'identity', ...headers },
  });
  invariant(response.ok, 'R2_OBJECT_UNAVAILABLE', 'Stored source is unavailable in object storage.');
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyPackRange(response, range, pin.size);
  invariant(
    bytes.length === pin.size && digest(bytes) === pin.sha256,
    'BLOB_DIGEST_MISMATCH',
    'Stored source differs from its digest.',
  );
  return bytes;
}

/** The import rows (path -> blob) that the stored State recorded, with sizes from the
 * stored objects. Same order and values the archive stream produced. Rows are made from the
 * State's bytes while publication reads them; only blob pins are kept by row. */
export async function rowsFromState(
  job: Doc<'projectGithubImports'>,
  stored: CatalogTable,
  pin: { sha256: string; size: number },
): Promise<ImportRows> {
  const entry = stored.get(pin.sha256);
  invariant(entry && entry.size === pin.size, 'INVALID_WORK_BACKUP', 'The stored State is missing.');
  const bytes = Buffer.alloc(pin.size);
  let at = 0;
  const append = (part: Buffer) => {
    invariant(at + part.length <= pin.size, 'INVALID_WORK_BACKUP', 'The stored State differs.');
    part.copy(bytes, at);
    at += part.length;
  };
  if (!entry.recipe) append(await rawBytes(job.projectId, stored, pin));
  else {
    const recipe = objectRecipeSchema.parse(
      JSON.parse(
        (
          await rawBytes(job.projectId, stored, { sha256: entry.recipe.digest, size: entry.recipe.size })
        ).toString(),
      ),
    );
    for await (const part of readObjectRecipe(recipe, chunk => rawBytes(job.projectId, stored, chunk)))
      append(part);
  }
  invariant(at === pin.size, 'INVALID_WORK_BACKUP', 'The stored State differs.');
  const pins = new ImportedPins(job.total);
  let files = 0;
  for (const { blob } of importStateFiles(bytes)) {
    const size = stored.get(blob)?.size;
    invariant(
      size !== undefined && files < job.total,
      'INVALID_WORK_BACKUP',
      size === undefined ? 'A stored source object is missing.' : 'The stored State lists other files.',
    );
    pins.set(files++, blob, size);
  }
  invariant(files === job.total, 'INVALID_WORK_BACKUP', 'The stored State lists other files.');
  return {
    imported: {
      *[Symbol.iterator]() {
        let index = 0;
        for (const { path, blob, mode } of importStateFiles(bytes))
          yield JSON.stringify({ path, blob, size: pins.size(index++), mode });
      },
    },
    blobs: {
      *[Symbol.iterator]() {
        for (const pin of pins.distinct()) yield JSON.stringify(pin);
      },
    },
  };
}

/** Publication retry of an archive import: every file is stored and the State is pinned
 * on the job, so rebuild its rows from stored objects and publish. No GitHub archive,
 * tree or blob request is made. False when the State cannot be read back, and the
 * caller then streams the archive as a first run would. */
export async function resumePublication(
  ctx: ActionCtx,
  job: Doc<'projectGithubImports'>,
  input: Identity,
  meter: ImportRequestMeter,
) {
  const pin = job.stateObject;
  if (!pin || !job.totalKnown || job.completed !== job.total) return false;
  const stored = await storedObjects(ctx, input);
  let rows: ImportRows;
  try {
    rows = await rowsFromState(job, stored, pin);
  } catch (error) {
    console.log(
      `FORGE_IMPORT_METRIC ${JSON.stringify({ projectId: job.projectId, phase: 'resume-fallback', at: Date.now(), reason: error instanceof ForgeError ? error.code : 'UNREADABLE' })}`,
    );
    return false;
  }
  console.log(
    `FORGE_IMPORT_METRIC ${JSON.stringify({ projectId: job.projectId, phase: 'resume', at: Date.now(), files: job.total, rssBytes: process.memoryUsage().rss })}`,
  );
  const record = async (objects: CatalogEntry[], state?: { sha256: string; size: number }) => {
    await ctx.runMutation(internal.projectGithubImportStore.archiveProgress, {
      ...input,
      step: job.step,
      completed: job.completed,
      total: job.total,
      bytes: job.bytes,
      totalBytes: job.totalBytes,
      submodules: job.submodules ?? 0,
      objects,
      ...(state ? { state } : {}),
      githubRequests: meter.counts,
    });
  };
  await publishImport(ctx, job, rows, { stored, record }, meter);
  await dropListing(job.projectId, job.listing);
  return true;
}
