// SPDX-License-Identifier: Apache-2.0
'use node';
import { createHash, randomBytes } from 'node:crypto';
import type { ActionCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { authorizeImportGithub } from './githubImportAccess';
import { importReadToken } from './githubAppToken';
import { convexFetch } from './networkFetch';
import { networkFetch } from '../src/network-fetch';
import type { ImportRequestMeter } from '../src/github-import-meter';
import { githubSourceMode, type GithubSourceEntry } from '../src/github-project-source';
import {
  listGithubTree,
  openGithubArchive,
  githubArchiveFiles,
  gitBlobId,
} from '../src/github-archive-source';
import { archiveCursorSchema, importPageFiles, lfsImportDefaultBytes } from '../src/github-import-pages';
import { ImportedPins, type ListingTable } from '../src/github-listing-codec';
import { ObjectRecipeBuilder, objectChunkBytes } from '../src/object-chunks';
import { githubBlobPack } from '../src/github-blob-pack';
import { streamGithubBlobPack } from '../src/github-blob-pack-stream';
import { invariant } from '../src/errors';
import { isGitattributesPath } from '../src/github-lfs';
import { LfsImport, lfsAttributeBytes } from '../src/github-lfs-import';
import { ImportUpload, type CatalogEntry } from './projectGithubImportUpload';
import { resumePublication, storedObjects } from './projectGithubImportResume';
import { dropImportScratch, jobListing, readPins, storePins } from './projectGithubImportListing';
import { publishImport, type ImportRows } from './projectGithubImportPublish';
import { stageFallbackBlobs } from './projectGithubImportFallback';

/** A run stops streaming here and continues in a fresh action; the platform
 * action limit is 10 minutes and publication needs headroom. */
export const archiveRunMillis = 6 * 60_000;
const packTimeoutMillis = 2 * 60_000;
/** Pack and empty-object PUTs may proceed independently within the bounded
 * source window and pack-copy memory. */
export const archiveUploadConcurrency = 32;

type Identity = { id: Id<'projectGithubImports'>; actor: string };
/** Verified GitHub archive members and pack blobs become content-addressed R2
 * packs. Convex sees one compact receipt per bounded upload window;
 * no per-file inventory row is written. Every file is proven against its Git
 * object ID from the listed commit tree before it can enter the State. */
export async function runArchiveImport(
  ctx: ActionCtx,
  job: Doc<'projectGithubImports'>,
  input: Identity,
  meter: ImportRequestMeter,
) {
  // Every file is stored and the State is pinned: a publication retry never streams again.
  if (await resumePublication(ctx, job, input, meter)) return;
  const started = Date.now(),
    cursor = archiveCursorSchema.parse(JSON.parse(job.cursor));
  const github = meter.wrap(networkFetch);
  const access = await authorizeImportGithub(job.repository, job.owner, github, ctx);
  invariant(
    job.visibility === 'private' || !access.repository.private,
    'GITHUB_VISIBILITY_CHANGED',
    'Repository visibility changed during import; main was not published.',
  );
  const token =
    (await importReadToken(
      access.repository.full_name,
      (access.repository as { id?: unknown }).id,
      meter.wrap(convexFetch),
    )) ?? access.token;
  // The file table is listed once per job (at start) and read back from R2 by every step.
  const { listing, pin: listingPin } = await jobListing(ctx, job, input, cursor.tree, () =>
    listGithubTree(job.repository, cursor.tree, token, github),
  );
  invariant(listing && listingPin, 'GITHUB_RESPONSE', 'GitHub no longer lists this commit tree completely.');
  console.log(
    `FORGE_IMPORT_METRIC ${JSON.stringify({ projectId: job.projectId, phase: 'listing', at: Date.now(), elapsedMillis: Date.now() - started, files: listing.length, sourceBytes: listing.totalBytes, rssBytes: process.memoryUsage().rss })}`,
  );
  // Progress is the stored objects themselves: one receipt per earlier window.
  const stored = await storedObjects(ctx, input);
  const saveWindow = async (objects: CatalogEntry[], state?: { sha256: string; size: number }) => {
    await ctx.runMutation(internal.projectGithubImportStore.archiveProgress, {
      ...input,
      step: job.step,
      ...counters(),
      objects,
      ...(state ? { state } : {}),
      githubRequests: meter.counts,
    });
  };
  const catalog = { stored, record: saveWindow };
  const upload = new ImportUpload(ctx, job.projectId, job.owner, archiveUploadConcurrency, catalog);
  // Pins by listing row: columns, not a path Map (memory per file bounds the import size).
  const imported =
    (cursor.pins && (await readPins(job.projectId, cursor.pins, cursor.tree, listingPin, listing.length))) ||
    new ImportedPins(listing.length);
  let bytes = 0;
  let lfsBytes = 0;
  const lfsOids = new Set<string>();
  if (cursor.pins)
    imported.retain(index => {
      const blob = imported.blob(index),
        size = imported.size(index);
      if (!stored.has(blob)) return false;
      if (listing.mode(index) !== '160000') bytes += size;
      if (imported.isLfs(index) && !lfsOids.has(blob)) {
        lfsOids.add(blob);
        lfsBytes += size;
      }
      return true;
    });
  const initialCount = imported.count;
  const record = (
    entry: GithubSourceEntry,
    pin: { blob: string; size: number },
    lfs?: true,
    index = listing.index(entry.path),
  ) => {
    invariant(index >= 0, 'GITHUB_RESPONSE', 'GitHub returned a file outside the listed tree.');
    if (imported.has(index)) return;
    imported.set(index, pin.blob, pin.size, lfs);
    if (entry.mode !== '160000') bytes += pin.size;
  };
  const counters = () => ({
    completed: imported.count,
    total: listing.length,
    bytes,
    // LFS objects replace their pointers' listed bytes once resolved.
    totalBytes: Math.max(listing.totalBytes, bytes),
    submodules: listing.submodules,
  });
  const pendingReceipts: CatalogEntry[][] = [];
  const flush = async () => {
    const receipt = upload.catalogReceipt();
    if (receipt.length || !pendingReceipts.length) pendingReceipts.push(receipt);
    while (pendingReceipts.length) {
      await saveWindow(pendingReceipts[0]!);
      pendingReceipts.shift();
    }
  };
  const drain = async () => {
    if (await upload.drain()) await flush();
  };
  const over = () => Date.now() - started >= archiveRunMillis;
  // Large members stream through bounded chunk windows into a recipe; the
  // recipe is only bound once the whole member matches its Git object ID.
  const streamLarge = async (
    entry: GithubSourceEntry,
    read: (consume: (part: Buffer) => Promise<void>) => Promise<void>,
    index?: number,
  ) => {
    const git = createHash(entry.sha.length === 40 ? 'sha1' : 'sha256').update(`blob ${entry.size}\0`),
      logical = createHash('sha256'),
      builder = new ObjectRecipeBuilder(upload.put);
    let size = 0;
    await read(async part => {
      size += part.length;
      git.update(part);
      logical.update(part);
      for (let offset = 0; offset < part.length; offset += 64 * 1024) {
        builder.update(part.subarray(offset, offset + 64 * 1024));
        await drain();
      }
    });
    if (size !== entry.size || git.digest('hex') !== entry.sha) return false;
    const pin = { blob: logical.digest('hex'), size };
    upload.recipe(pin, builder.finish({ sha256: pin.blob, size }).bytes);
    record(entry, pin, undefined, index);
    return true;
  };
  const limit = cursor.lfsLimitBytes ?? lfsImportDefaultBytes;
  const lfs = new LfsImport(limit, { carried: lfsBytes, previouslyCounted: oid => lfsOids.has(oid) });
  const fallback = {
    upload,
    fetchBlobs: (entries: GithubSourceEntry[]) => githubBlobPack(job.repository, entries, token, github),
    record,
    drain,
    over,
    hold: lfs.hold.bind(lfs),
  };
  const missing = function* (start: number, end: number, kind: 'gitlink' | 'small' | 'large') {
    for (let index = start; index < end; index++) {
      if (imported.has(index) || lfs.isHeld(listing.path(index))) continue;
      const mode = listing.mode(index);
      const rowKind =
        mode === '160000' ? 'gitlink' : listing.size(index) <= objectChunkBytes ? 'small' : 'large';
      if (kind === rowKind) yield listing.entry(index);
    }
  };
  const attributes = function* () {
    for (let index = 0; index < listing.length; index++) {
      if (
        listing.size(index) <= lfsAttributeBytes &&
        (listing.mode(index) === '100644' || listing.mode(index) === '100755') &&
        isGitattributesPath(listing.path(index))
      )
        yield listing.entry(index);
    }
  };
  const stageMissing = async (start: number, end: number, pageFiles?: number) => {
    // Gitlinks and large blobs use separate passes so their presence cannot
    // fragment packs of small blobs, regardless of where they sort.
    for (const entry of missing(start, end, 'gitlink')) {
      if (cursor.pins && over()) break;
      const pin = upload.put(Buffer.from(entry.sha));
      record(entry, { blob: pin.sha256, size: pin.size });
      await drain();
    }
    // Once we hold pointers, leave space for LFS to resolve them in this action.
    const sourceOver = () =>
      over() ||
      Boolean(cursor.pins && lfs.holding && Date.now() - started >= archiveRunMillis - packTimeoutMillis);
    await stageFallbackBlobs(missing(start, end, 'small'), { ...fallback, over: sourceOver }, pageFiles);
    for (const entry of missing(start, end, 'large')) {
      if (sourceOver()) break;
      const matched = await streamLarge(entry, async consume => {
        await streamGithubBlobPack(job.repository, entry, consume, token, github);
      });
      invariant(matched, 'ARTIFACT_INTEGRITY', 'GitHub blob differs from the selected commit.');
    }
  };
  let attempt: Buffer | undefined;
  let prepared: Awaited<ReturnType<typeof storePins>> | undefined;
  const checkpoint = async (advance: boolean) => {
    const pins = (prepared ??= await storePins(
      job.projectId,
      cursor.tree,
      listingPin,
      imported,
      (attempt ??= randomBytes(16)),
    ));
    const next = JSON.stringify({ ...cursor, runs: cursor.runs + Number(advance), pins });
    const accepted = advance
      ? await ctx.runMutation(internal.projectGithubImportStore.advance, {
          ...input,
          step: job.step,
          cursor: next,
          ...counters(),
          discovering: false,
          githubRequests: meter.counts,
        })
      : await ctx.runMutation(internal.projectGithubImportStore.archiveCheckpoint, {
          ...input,
          step: job.step,
          previousCursor: job.cursor,
          cursor: next,
        });
    if (accepted) await dropImportScratch(job.projectId, cursor.pins);
    else {
      // Reconcile a lost advance reply or a superseded worker before touching
      // the attempted key. A newer cursor may already have selected it.
      const current = await ctx.runQuery(internal.projectGithubImportStore.get, input);
      const selected = archiveCursorSchema.parse(JSON.parse(current.cursor)).pins?.sha256;
      if (selected !== pins.sha256) await dropImportScratch(job.projectId, pins);
      if (selected !== cursor.pins?.sha256) await dropImportScratch(job.projectId, cursor.pins);
    }
  };
  try {
    if (cursor.pins) {
      // Every rule must be present even when the file that defines it is pinned.
      if (limit) await stageFallbackBlobs(attributes(), fallback, importPageFiles);
      await stageMissing(0, listing.length, importPageFiles);
    } else {
      const archive = await openGithubArchive(job.repository, job.commit, token, github);
      console.log(
        `FORGE_IMPORT_METRIC ${JSON.stringify({ projectId: job.projectId, phase: 'archive-open', at: Date.now(), elapsedMillis: Date.now() - started })}`,
      );
      let seen = 0,
        complete = true;
      for await (const file of githubArchiveFiles(archive, listing, objectChunkBytes)) {
        // Let a run that has verified the last file publish at its time budget.
        if (seen++ && over()) {
          complete = false;
          break;
        }
        if (file.bytes) {
          if (gitBlobId(file.entry.sha, file.bytes) === file.entry.sha && !lfs.hold(file.entry, file.bytes)) {
            const pin = upload.put(file.bytes);
            record(file.entry, { blob: pin.sha256, size: pin.size }, undefined, file.index);
          }
        } else await streamLarge(file.entry, file.read!, file.index);
        await drain();
      }
      if (complete) await stageMissing(0, listing.length);
    }
    if (!over() || (cursor.pins && lfs.holding))
      await lfs.resolve({
        repository: job.repository,
        // Public repositories read LFS anonymously; private ones use the import token.
        ...(access.repository.private ? { token } : {}),
        stored: oid => stored.has(oid),
        put: upload.put,
        large: async (pointer, read) => {
          const builder = new ObjectRecipeBuilder(upload.put);
          await read(async part => {
            for (let offset = 0; offset < part.length; offset += 64 * 1024) {
              builder.update(part.subarray(offset, offset + 64 * 1024));
              await drain();
            }
          });
          const pin = { blob: pointer.oid, size: pointer.size };
          upload.recipe(pin, builder.finish({ sha256: pin.blob, size: pin.size }).bytes);
        },
        record,
        drain,
        // A pack started before the soft deadline can deliver pointers after it.
        over: cursor.pins ? () => Date.now() - started >= archiveRunMillis + packTimeoutMillis : over,
      });
    await upload.drain(true);
    await flush();
    console.log(
      `FORGE_IMPORT_METRIC ${JSON.stringify({ projectId: job.projectId, phase: 'archive-complete', at: Date.now(), elapsedMillis: Date.now() - started, files: imported.count, lfsObjects: lfs.objects, lfsBytes: lfs.objectBytes, lfsFetched: lfs.fetched, putAttempts: upload.putAttempts, putBytes: upload.putBytes, uploadMillis: upload.uploadMillis, peakBufferedBytes: upload.peakBufferedBytes, rssBytes: process.memoryUsage().rss })}`,
    );
    if (imported.count < listing.length) {
      invariant(
        !cursor.pins || imported.count > initialCount,
        'GITHUB_ARCHIVE_TOO_LARGE',
        'This import step verified no new files. Retry from its saved progress.',
      );
      await checkpoint(true);
      return;
    }
    await publishImport(
      ctx,
      { ...job, ...counters(), totalKnown: true },
      archiveRows(listing, imported),
      catalog,
      meter,
    );
  } catch (error) {
    // Preserve the original failure. Only checkpoint after flushing receipts,
    // and drop pins from any upload window that did not finish.
    if (!cursor.pins || imported.count > initialCount)
      try {
        await upload.drain(true).catch(() => {});
        await flush();
        imported.retain(index => stored.has(imported.blob(index)));
        await checkpoint(false);
      } catch (checkpointError) {
        console.log(
          `FORGE_IMPORT_METRIC ${JSON.stringify({ projectId: job.projectId, phase: 'checkpoint-failed', reason: checkpointError instanceof Error ? checkpointError.name : 'UNKNOWN' })}`,
        );
      }
    throw error;
  }
  await Promise.all([
    dropImportScratch(job.projectId, listingPin),
    dropImportScratch(job.projectId, cursor.pins),
  ]);
}

function archiveRows(listing: ListingTable, imported: ImportedPins): ImportRows {
  // Rows are produced page by page while publication reads them: 100,000 files
  // as materialized JSON rows held about 190 MB of a 512 MB action.
  return {
    imported: {
      *[Symbol.iterator]() {
        for (let index = 0; index < listing.length; index++)
          yield JSON.stringify({
            path: listing.path(index),
            blob: imported.blob(index),
            size: imported.size(index),
            mode: githubSourceMode(listing.mode(index)),
          });
      },
    },
    blobs: {
      *[Symbol.iterator]() {
        for (const pin of imported.distinct()) yield JSON.stringify(pin);
      },
    },
  };
}
