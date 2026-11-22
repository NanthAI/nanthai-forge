// SPDX-License-Identifier: Apache-2.0
'use node';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import type { ActionCtx } from './_generated/server';
import { presignGet, presignPut, r2Config, r2ImportListingKey } from './r2';
import { deleteR2Object } from './r2Operations';
import { exchangeFetch, exchangeRequest } from '../src/exchange-request';
import { digest } from '../src/hash';
import { invariant } from '../src/errors';
import { ImportedPins, ListingTable } from '../src/github-listing-codec';

type Pin = { sha256: string; size: number };
/** Writes the file table of a commit tree to the project's R2 prefix (create-only, checksummed;
 * the key names the digest, so an existing key holds these exact bytes). */
export async function storeListing(projectId: Id<'hostedProjects'>, tree: string, listing: ListingTable) {
  return storeScratch(projectId, listing.encode(tree), 'listing');
}

export async function storePins(
  projectId: Id<'hostedProjects'>,
  tree: string,
  listing: Pin,
  pins: ImportedPins,
  attempt: Buffer,
) {
  return storeScratch(projectId, pins.encode(tree, listing.sha256, attempt), 'pins');
}

async function storeScratch(projectId: Id<'hostedProjects'>, bytes: Buffer, kind: 'listing' | 'pins') {
  const pin: Pin = { sha256: digest(bytes), size: bytes.length };
  const put = await presignPut(r2Config(), r2ImportListingKey(projectId, pin.sha256), {
    digest: pin.sha256,
    size: pin.size,
  });
  const response = await exchangeFetch(`R2 import ${kind} upload`, put.url, {
    method: 'PUT',
    headers: put.headers,
    body: new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.length),
  });
  invariant(
    response.ok || response.status === 412,
    'R2_UPLOAD_FAILED',
    'Object storage could not upload source.',
  );
  return pin;
}
/** The stored table when it is present and still the verified table for `tree`; null otherwise. */
async function readListing(projectId: Id<'hostedProjects'>, pin: Pin, tree: string) {
  const bytes = await readScratch(projectId, pin, 'listing');
  return bytes && ListingTable.decode(bytes, tree);
}

export async function readPins(
  projectId: Id<'hostedProjects'>,
  pin: Pin,
  tree: string,
  listing: Pin,
  rows: number,
) {
  const bytes = await readScratch(projectId, pin, 'pins');
  return bytes && ImportedPins.decode(bytes, tree, listing.sha256, rows);
}

async function readScratch(projectId: Id<'hostedProjects'>, pin: Pin, kind: 'listing' | 'pins') {
  try {
    const url = await presignGet(r2Config(), r2ImportListingKey(projectId, pin.sha256));
    return await exchangeRequest(
      `R2 import ${kind} read`,
      url,
      { headers: { 'accept-encoding': 'identity' } },
      async (response, progressed) => {
        if (!response.ok || !response.body) return null;
        const length = response.headers.get('content-length');
        if (length !== null && Number(length) !== pin.size) return null;
        const bytes = Buffer.allocUnsafe(pin.size);
        let offset = 0;
        const reader = response.body.getReader();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (chunk.value.byteLength > pin.size - offset) return null;
            bytes.set(chunk.value, offset);
            offset += chunk.value.byteLength;
            progressed();
          }
        } finally {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        return offset === pin.size && digest(bytes) === pin.sha256 ? bytes : null;
      },
    );
  } catch {
    return null;
  }
}
/** The job's file table: read back from R2 when it was stored, otherwise listed (the caller's
 * GitHub reads) and stored then. `listing` is null only when GitHub cannot list the tree
 * completely; `pin` names the stored table for scratch cleanup. */
export async function jobListing(
  ctx: ActionCtx,
  job: Doc<'projectGithubImports'>,
  input: { id: Id<'projectGithubImports'>; actor: string },
  tree: string,
  list: () => Promise<ListingTable | null>,
) {
  const started = Date.now();
  const stored = job.listing ? await readListing(job.projectId, job.listing, tree) : null;
  if (stored) {
    console.log(
      `FORGE_IMPORT_METRIC ${JSON.stringify({ projectId: job.projectId, phase: 'listing-stored', at: Date.now(), elapsedMillis: Date.now() - started, files: stored.length })}`,
    );
    return { listing: stored, pin: job.listing };
  }
  const listing = await list();
  if (!listing) return { listing: null, pin: undefined };
  const pin = await storeListing(job.projectId, tree, listing);
  await ctx.runMutation(internal.projectGithubImportStore.pinListing, { ...input, listing: pin });
  return { listing, pin };
}
/** Best effort for scratch no longer needed. Project purge also removes it. */
export async function dropImportScratch(projectId: Id<'hostedProjects'>, pin: Pin | undefined) {
  if (!pin) return;
  try {
    await deleteR2Object(r2Config(), r2ImportListingKey(projectId, pin.sha256));
  } catch {
    /* The project-prefix purge removes it with the project. */
  }
}
