// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
'use node';
import type { Doc, Id } from './_generated/dataModel';
import { r2Config, r2Key, presignGet } from './r2';
import { exchangeRequest } from '../src/exchange-request';
import { invariant } from '../src/errors';
import { objectRecipeSchema, readObjectRecipe, type ChunkPin } from '../src/object-chunks';
import { packHeaders, packRange, verifyPackRange } from '../src/object-pack-range';
import type { CatalogTable } from '../src/import-catalog-table';
import { importStateFiles, importStatePrefix, importStateSuffix } from '../src/import-state-scan';
import {
  openImportScratch,
  readImportBody,
  requireImportRange,
  writeImportRange,
} from './projectGithubImportScratch';
import type { ImportRows } from './projectGithubImportPublish';

/** Resolve exact stored bytes in bounded chunks, including legacy raw States. */
async function readStored(
  projectId: Id<'hostedProjects'>,
  stored: CatalogTable,
  pin: ChunkPin,
  consume: Parameters<typeof readImportBody>[3],
) {
  const entry = stored.get(pin.sha256);
  invariant(
    entry && !entry.recipe && entry.size === pin.size,
    'INVALID_WORK_BACKUP',
    'A stored source object is missing.',
  );
  const range = packRange(entry),
    headers = packHeaders(range, pin.size);
  const url = await presignGet(r2Config(), r2Key(projectId, entry.pack?.digest ?? pin.sha256), headers);
  await exchangeRequest(
    'R2 import resume read',
    url,
    { headers: { 'accept-encoding': 'identity', ...headers } },
    async (response, progressed) => {
      invariant(response.ok, 'R2_OBJECT_UNAVAILABLE', 'Stored source is unavailable in object storage.');
      verifyPackRange(response, range, pin.size);
      invariant(
        await readImportBody(response, pin, progressed, consume),
        'BLOB_DIGEST_MISMATCH',
        'Stored source differs from its digest.',
      );
    },
  );
}

const stateRowBoundary = Buffer.from('},{"path":');
const scanBytes = 1024 * 1024;

/** Copy the verified State to disk once, then reuse bounded local ranges for
 * both ordered scans. Read each R2 recipe object once per occurrence. */
export async function rowsFromState(job: Doc<'projectGithubImports'>, stored: CatalogTable, pin: ChunkPin) {
  const entry = stored.get(pin.sha256);
  invariant(entry && entry.size === pin.size, 'INVALID_WORK_BACKUP', 'The stored State is missing.');
  const scratch = await openImportScratch();
  let keep = false;
  try {
    if (!entry.recipe) {
      await readStored(job.projectId, stored, pin, (bytes, offset) =>
        writeImportRange(scratch.file, bytes, offset),
      );
    } else {
      const rawBytes = async (part: ChunkPin) => {
        const bytes = Buffer.allocUnsafe(part.size);
        await readStored(job.projectId, stored, part, (chunk, offset) => {
          bytes.set(chunk, offset);
        });
        return bytes;
      };
      const ref = { sha256: entry.recipe.digest, size: entry.recipe.size };
      const recipe = objectRecipeSchema.parse(JSON.parse((await rawBytes(ref)).toString()));
      invariant(
        recipe.object.sha256 === pin.sha256 && recipe.object.size === pin.size,
        'INVALID_WORK_BACKUP',
        'The stored State recipe differs from its pin.',
      );
      let offset = 0;
      for await (const part of readObjectRecipe(recipe, rawBytes)) {
        await writeImportRange(scratch.file, part, offset);
        offset += part.length;
      }
    }
    const suffix = importStateSuffix(job.commit, job.at);
    const start = importStatePrefix.length;
    const end = pin.size - suffix.length;
    invariant(end >= start, 'INVALID_WORK_BACKUP', 'The stored State differs.');
    const first = Buffer.allocUnsafe(start),
      last = Buffer.allocUnsafe(suffix.length);
    await requireImportRange(scratch.file, first, 0);
    await requireImportRange(scratch.file, last, end);
    invariant(
      first.equals(importStatePrefix) && last.equals(suffix),
      'INVALID_WORK_BACKUP',
      'The stored State differs.',
    );
    const buffer = Buffer.allocUnsafe(scanBytes);
    const rows: ImportRows = {
      async *[Symbol.asyncIterator]() {
        for (let offset = start; offset < end;) {
          const remaining = end - offset;
          let batch = buffer.subarray(0, Math.min(buffer.length, remaining));
          await requireImportRange(scratch.file, batch, offset);
          for (;;) {
            const last = batch.length === remaining;
            // An unescaped JSON key separates records. It cannot occur inside a path string.
            const boundary = last ? batch.length : batch.lastIndexOf(stateRowBoundary) + 1;
            if (boundary) {
              yield (function* () {
                for (const file of importStateFiles(batch.subarray(0, boundary), false)) {
                  const size = stored.sizeOf(file.blob);
                  invariant(size !== undefined, 'INVALID_WORK_BACKUP', 'A stored source object is missing.');
                  yield { ...file, size };
                }
              })();
              offset += boundary + Number(!last);
              break;
            }
            // A single unusually long path may span the default read window.
            const expanded = Buffer.allocUnsafe(Math.min(batch.length * 2, remaining));
            expanded.set(batch);
            await requireImportRange(scratch.file, expanded.subarray(batch.length), offset + batch.length);
            batch = expanded;
          }
        }
      },
    };
    // Validate the State before the caller chooses it over reacquisition.
    let files = 0;
    let previous = '';
    for await (const range of rows)
      for (const file of range) {
        invariant(file.path > previous, 'INVALID_WORK_BACKUP', 'The stored State lists unordered files.');
        previous = file.path;
        files++;
      }
    invariant(files === job.total, 'INVALID_WORK_BACKUP', 'The stored State lists other files.');
    keep = true;
    return { rows, close: scratch.close };
  } finally {
    if (!keep) await scratch.close();
  }
}
