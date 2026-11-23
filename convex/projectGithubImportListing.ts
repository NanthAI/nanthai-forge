// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
'use node';
import { logImportMetric } from '../src/github-import-metric';
import { randomBytes, randomFillSync } from 'node:crypto';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import type { ActionCtx } from './_generated/server';
import { presignGet, presignPut, r2Config, r2ImportListingKey } from './r2';
import { deleteR2Object, listR2Prefix } from './r2Operations';
import { exchangeFetch, exchangeRequest } from '../src/exchange-request';
import { digest } from '../src/hash';
import { invariant } from '../src/errors';
import {
  decodeListingIndex,
  ImportedPins,
  ListingPageWriter,
  ListingPages,
} from '../src/github-listing-codec';
import { listGithubTree } from '../src/github-archive-source';
import type { GithubFetch } from '../src/github';
import type { ImportRequestMeter } from '../src/github-import-meter';
import { importPageBytes } from '../src/github-import-pages';
import {
  openImportScratch,
  readImportBody,
  readImportRange,
  writeImportRange,
} from './projectGithubImportScratch';

type Pin = { sha256: string; size: number };
const listingHeader = Buffer.from('{"schema":3,');

export async function storePins(
  projectId: Id<'hostedProjects'>,
  tree: string,
  listing: Pin,
  pins: ImportedPins,
  attempt: Buffer,
) {
  return storeScratch(projectId, pins.encode(tree, listing.sha256, attempt), 'pins');
}

async function storeScratch(
  projectId: Id<'hostedProjects'>,
  bytes: Buffer,
  kind: 'listing' | 'pins',
  alternate?: () => Buffer,
): Promise<Pin> {
  const pin: Pin = { sha256: digest(bytes), size: bytes.length };
  const put = await presignPut(r2Config(), r2ImportListingKey(projectId, pin.sha256), {
    digest: pin.sha256,
    size: pin.size,
  });
  const body = new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.length);
  const streamed = body.length > importPageBytes;
  const init: RequestInit & { duplex?: 'half' } = {
    method: 'PUT',
    headers: put.headers,
    ...(streamed ? { duplex: 'half' } : { body }),
  };
  const response = await exchangeFetch(
    `R2 import ${kind} upload`,
    put.url,
    init,
    streamed
      ? {
          makeBody: () =>
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(body);
                controller.close();
              },
            }),
        }
      : {},
  );
  invariant(
    response.ok || response.status === 412,
    'R2_UPLOAD_FAILED',
    'Object storage could not upload source.',
  );
  if (response.status === 412 && !(await readScratch(projectId, pin, kind))) {
    // An altered object cannot be selected or replaced in place. Select a
    // verified alternate key and leave both keys to the same prefix cleanup.
    invariant(alternate, 'R2_UPLOAD_FAILED', 'Stored import scratch did not match the uploaded bytes.');
    return storeScratch(projectId, alternate(), kind);
  }
  return pin;
}
/** Fetch and verify each page once. A private action-local copy serves repeated
 * scans and out-of-order tar members without making another R2 request. */
export async function readListing(
  projectId: Id<'hostedProjects'>,
  pin: Pin,
  tree: string,
  indexTarMembers: boolean,
) {
  const bytes = await readScratch(projectId, pin, 'listing', { header: listingHeader });
  const index = bytes && decodeListingIndex(bytes, tree);
  if (!index) return null;
  const buffer = Buffer.allocUnsafe(index.pages.reduce((max, page) => Math.max(max, page.size), 0));
  const { file, close } = await openImportScratch();
  const offsets = new Map<string, number>();
  let offset = 0;
  let keep = false;
  try {
    const listing = await ListingPages.open(
      index,
      async (page, span) => {
        if (!keep) {
          const raw = await readScratch(projectId, page, 'listing', { buffer });
          if (!raw) return null;
          await file.writeFile(raw);
          offsets.set(page.sha256, offset);
          offset += raw.length;
          return raw;
        }
        const start = offsets.get(page.sha256)! + (span?.offset ?? 0);
        const raw = buffer.subarray(0, span?.size ?? page.size);
        if (!(await readImportRange(file, raw, start))) return null;
        return digest(raw) === (span?.sha256 ?? page.sha256) ? raw : null;
      },
      indexTarMembers,
    );
    if (!listing) return null;
    keep = true;
    return { listing, close };
  } finally {
    if (!keep) await close();
  }
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

export async function openPinCheckpoint(projectId: Id<'hostedProjects'>, pin: Pin) {
  const scratch = await openImportScratch();
  const verified = await readScratchParts(projectId, pin, 'pins', (bytes, offset) =>
    writeImportRange(scratch.file, bytes, offset),
  );
  if (verified) return scratch;
  await scratch.close();
  return null;
}

async function readScratch(
  projectId: Id<'hostedProjects'>,
  pin: Pin,
  kind: 'listing' | 'pins',
  { header, buffer }: { header?: Buffer; buffer?: Buffer } = {},
) {
  let bytes: Buffer | undefined;
  const verified = await readScratchParts(projectId, pin, kind, (chunk, offset) => {
    if (header && offset < header.length)
      for (let i = 0; i < Math.min(chunk.length, header.length - offset); i++)
        if (header[offset + i] !== chunk[i]) return false;
    bytes ??= buffer?.subarray(0, pin.size) ?? Buffer.allocUnsafe(pin.size);
    bytes.set(chunk, offset);
  });
  return verified && bytes ? bytes : null;
}

async function readScratchParts(
  projectId: Id<'hostedProjects'>,
  pin: Pin,
  kind: 'listing' | 'pins',
  consume: Parameters<typeof readImportBody>[3],
) {
  try {
    const url = await presignGet(r2Config(), r2ImportListingKey(projectId, pin.sha256));
    return await exchangeRequest(
      `R2 import ${kind} read`,
      url,
      { headers: { 'accept-encoding': 'identity' } },
      (response, progressed) => readImportBody(response, pin, progressed, consume),
    );
  } catch {
    return false;
  }
}
/** A listing-only step writes the pages and advances the job. The next action
 * reads the finished table, so listing and acquisition memory do not overlap. */
export async function jobListing(
  ctx: ActionCtx,
  job: Doc<'projectGithubImports'>,
  input: { id: Id<'projectGithubImports'>; actor: string },
  tree: string,
  token: string | undefined,
  github: GithubFetch,
  meter: ImportRequestMeter,
  indexTarMembers: boolean,
) {
  const started = Date.now();
  const stored = job.listing && (await readListing(job.projectId, job.listing, tree, indexTarMembers));
  if (stored) {
    logImportMetric({
      projectId: job.projectId,
      phase: 'listing-stored',
      at: Date.now(),
      elapsedMillis: Date.now() - started,
      files: stored.listing.length,
    });
    return Object.assign(stored, { pin: job.listing! });
  }
  const writer = new ListingPageWriter((page, nonce) =>
    storeScratch(job.projectId, page, 'listing', () => {
      randomFillSync(nonce);
      return page;
    }),
  );
  const totals = await listGithubTree(job.repository, tree, token, github, writer);
  const identity = { ...input, step: job.step };
  if (!totals) {
    let switched: boolean;
    try {
      switched = await ctx.runMutation(internal.projectGithubImportStore.switchToPaged, {
        ...identity,
        githubRequests: meter.counts,
      });
    } catch (error) {
      const current = await ctx.runQuery(internal.projectGithubImportStore.get, input);
      if (current.protocol !== 2) throw error;
      switched = true;
    }
    if (switched) await dropListing(job.projectId);
    return null;
  }
  const index = await writer.finish(tree, totals);
  const pin = await storeScratch(job.projectId, Buffer.from(JSON.stringify(index)), 'listing', () =>
    Buffer.from(JSON.stringify({ ...index, nonce: randomBytes(16).toString('hex') })),
  );
  await ctx.runMutation(internal.projectGithubImportStore.pinListing, {
    ...identity,
    listing: pin,
    total: totals.files,
    totalBytes: totals.totalBytes,
    submodules: totals.submodules,
    githubRequests: meter.counts,
  });
  logImportMetric({
    projectId: job.projectId,
    phase: 'listing-written',
    at: Date.now(),
    elapsedMillis: Date.now() - started,
    files: totals.files,
    sourceBytes: totals.totalBytes,
    pages: index.pages.length,
  });
  return null;
}

/** Scratch has one project prefix, including pages from an interrupted listing
 * whose index was never pinned. Project purge is the fallback on R2 errors. */
export async function dropListing(projectId: Id<'hostedProjects'>) {
  try {
    const config = r2Config();
    const prefix = r2ImportListingKey(projectId, '');
    // List after the last deleted key. Continuation tokens need not survive deletes.
    let after: string | undefined;
    for (;;) {
      const list = () => listR2Prefix(config, prefix, null, after);
      const page = await list().catch(list);
      for (const key of page.keys) {
        const remove = () => deleteR2Object(config, key);
        try {
          await remove().catch(remove);
        } catch {
          // A persistent failure for one key does not strand the other pages.
          logImportMetric({ projectId, phase: 'scratch-delete-failed' });
        }
      }
      if (page.isDone || !page.keys.length) return;
      after = page.keys.at(-1);
    }
  } catch {
    /* The project-prefix purge removes it with the project. */
  }
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
