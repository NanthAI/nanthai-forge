// SPDX-License-Identifier: Apache-2.0
'use node';
import type { Doc } from './_generated/dataModel';
import type { CatalogTable } from '../src/import-catalog-table';
import { matchesPinCheckpoint, pinsHeaderBytes, type ListingPages } from '../src/github-listing-codec';
import { githubSourceMode } from '../src/github-project-source';
import { openPinCheckpoint } from './projectGithubImportListing';
import { requireImportRange } from './projectGithubImportScratch';
import type { ImportRows } from './projectGithubImportPublish';

type Pin = { sha256: string; size: number };
interface PinRows {
  blob(index: number): string;
  size(index: number): number;
}

export function archiveRows(
  listing: ListingPages,
  pins: (start: number, length: number) => PinRows | Promise<PinRows>,
): ImportRows {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const page of listing.pages()) {
        const imported = await pins(page.start, page.length);
        yield (function* () {
          for (let row = 0; row < page.length; row++) {
            const index = page.start + row;
            yield {
              path: page.path(row),
              blob: imported.blob(index),
              size: imported.size(index),
              mode: githubSourceMode(page.mode(row)),
            };
          }
        })();
      }
    },
  };
}

/** A complete checkpoint is verified once. Publication only needs ordered
 * ranges, so keep the original pin columns in an action-local file. */
export async function completeArchiveRows(
  job: Doc<'projectGithubImports'>,
  listing: ListingPages,
  listingPin: Pin,
  tree: string,
  pin: Pin,
  stored: CatalogTable,
) {
  if (pin.size < pinsHeaderBytes || listing.length !== job.total) return null;
  const scratch = await openPinCheckpoint(job.projectId, pin);
  if (!scratch) return null;
  let keep = false;
  try {
    const header = Buffer.allocUnsafe(pinsHeaderBytes);
    await requireImportRange(scratch.file, header, 0);
    const length = listing.length;
    if (!matchesPinCheckpoint(header, pin.size, tree, listingPin.sha256, length)) return null;
    const capacity = 4096;
    const blobs = Buffer.allocUnsafe(capacity * 32);
    const sizes = Buffer.allocUnsafe(capacity * 8);
    const statuses = Buffer.allocUnsafe(capacity);
    async function load(start: number, rows: number) {
      await requireImportRange(scratch!.file, blobs.subarray(0, 32 * rows), pinsHeaderBytes + 32 * start);
      await requireImportRange(
        scratch!.file,
        sizes.subarray(0, 8 * rows),
        pinsHeaderBytes + 32 * length + 8 * start,
      );
    }
    const digestAt = (row: number) => blobs.toString('hex', 32 * row, 32 * (row + 1));
    const sizeAt = (row: number) => sizes.readDoubleLE(8 * row);
    for (let start = 0; start < length; start += capacity) {
      const count = Math.min(capacity, length - start);
      await load(start, count);
      await requireImportRange(
        scratch.file,
        statuses.subarray(0, count),
        pinsHeaderBytes + 40 * length + start,
      );
      for (let row = 0; row < count; row++) {
        const status = statuses[row];
        if ((status !== 1 && status !== 2) || stored.sizeOf(digestAt(row)) !== sizeAt(row)) return null;
      }
    }
    const rows: ImportRows = {
      async *[Symbol.asyncIterator]() {
        for await (const page of listing.pages()) {
          for (let offset = 0; offset < page.length; offset += capacity) {
            const count = Math.min(capacity, page.length - offset);
            await load(page.start + offset, count);
            yield (function* () {
              for (let row = 0; row < count; row++) {
                const position = offset + row;
                yield {
                  path: page.path(position),
                  blob: digestAt(row),
                  size: sizeAt(row),
                  mode: githubSourceMode(page.mode(position)),
                };
              }
            })();
          }
        }
      },
    };
    keep = true;
    return { rows, close: scratch.close };
  } finally {
    if (!keep) await scratch.close();
  }
}
