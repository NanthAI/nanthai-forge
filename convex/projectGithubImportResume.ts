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
import { importPathKey } from '../src/github-import-pages';
import type { ImportRequestMeter } from '../src/github-import-meter';
import { windowEntries } from './projectGithubImportCatalog';
import type { CatalogEntry } from './projectGithubImportUpload';
import { publishImport, type ImportRows } from './projectGithubImportPublish';

type Identity = { id: Id<'projectGithubImports'>; actor: string };

/** Progress of an archive import is the objects its windows stored: one receipt per window. */
export async function storedObjects(ctx: ActionCtx, input: Identity) {
  const stored = new Map<string, CatalogEntry>();
  for (let after = ''; ;) {
    const rows = await ctx.runQuery(internal.projectGithubImportCatalog.stored, { ...input, after });
    if (!rows.length) break;
    for (const row of rows) for (const entry of windowEntries(row.value)) stored.set(entry.digest, entry);
    after = rows.at(-1)!.key;
  }
  return stored;
}

/** One stored object, read back from R2 (a raw object, or one range of its pack) and verified. */
async function rawBytes(projectId: Id<'hostedProjects'>, stored: Map<string, CatalogEntry>, pin: ChunkPin) {
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
 * stored objects. Same order and values the archive stream produced. */
export async function rowsFromState(
  job: Doc<'projectGithubImports'>,
  stored: Map<string, CatalogEntry>,
  pin: { sha256: string; size: number },
): Promise<ImportRows> {
  const entry = stored.get(pin.sha256);
  invariant(entry && entry.size === pin.size, 'INVALID_WORK_BACKUP', 'The stored State is missing.');
  const parts: Buffer[] = [];
  if (!entry.recipe) parts.push(await rawBytes(job.projectId, stored, pin));
  else {
    const recipe = objectRecipeSchema.parse(
      JSON.parse(
        (
          await rawBytes(job.projectId, stored, { sha256: entry.recipe.digest, size: entry.recipe.size })
        ).toString(),
      ),
    );
    for await (const part of readObjectRecipe(recipe, chunk => rawBytes(job.projectId, stored, chunk)))
      parts.push(part);
  }
  const state: { files: { path: string; blob: string; mode: string }[] } = JSON.parse(
    Buffer.concat(parts).toString(),
  );
  invariant(state.files.length === job.total, 'INVALID_WORK_BACKUP', 'The stored State lists other files.');
  const rows: ImportRows = { imported: [], blobs: [] };
  const blobs = new Map<string, number>();
  for (const { path, blob, mode } of state.files) {
    const size = stored.get(blob)?.size;
    invariant(size !== undefined, 'INVALID_WORK_BACKUP', 'A stored source object is missing.');
    rows.imported.push({ key: importPathKey(path), value: JSON.stringify({ path, blob, size, mode }) });
    blobs.set(blob, size);
  }
  for (const [sha256, size] of [...blobs].sort(([a], [b]) => (a < b ? -1 : 1)))
    rows.blobs.push({ key: sha256, value: JSON.stringify({ sha256, size }) });
  return rows;
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
    `FORGE_IMPORT_METRIC ${JSON.stringify({ projectId: job.projectId, phase: 'resume', at: Date.now(), files: rows.imported.length })}`,
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
  return true;
}
