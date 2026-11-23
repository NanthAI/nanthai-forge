// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
'use node';
import { logImportMetric } from '../src/github-import-metric';
import { createHash, randomBytes } from 'node:crypto';
import type { ActionCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { authorizeImportGithub } from './githubImportAccess';
import { importReadToken } from './githubAppToken';
import { convexFetch } from './networkFetch';
import { networkFetch } from '../src/network-fetch';
import type { ImportRequestMeter } from '../src/github-import-meter';
import { type GithubSourceEntry } from '../src/github-project-source';
import { openGithubArchive, githubArchiveFiles, gitBlobId } from '../src/github-archive-source';
import { archiveCursorSchema, importPageFiles, lfsImportDefaultBytes } from '../src/github-import-pages';
import { ImportedPins, type ListedGithubEntry } from '../src/github-listing-codec';
import { ObjectRecipeBuilder, objectChunkBytes } from '../src/object-chunks';
import { githubBlobPack } from '../src/github-blob-pack';
import { streamGithubBlobPack } from '../src/github-blob-pack-stream';
import { invariant } from '../src/errors';
import { isGitattributesPath } from '../src/github-lfs';
import { LfsImport, lfsAttributeBytes } from '../src/github-lfs-import';
import { ImportUpload, type CatalogEntry } from './projectGithubImportUpload';
import { resumePublication, storedObjects } from './projectGithubImportResume';
import {
  dropImportScratch,
  dropListing,
  jobListing,
  readPins,
  storePins,
} from './projectGithubImportListing';
import { publishImport } from './projectGithubImportPublish';
import { archiveRows } from './projectGithubImportRows';
import { stageFallbackBlobs } from './projectGithubImportFallback';

/** A run stops streaming here and continues in a fresh action; the platform
 * action limit is 10 minutes and publication needs headroom. */
export const archiveRunMillis = 6 * 60_000;
const packTimeoutMillis = 2 * 60_000;
// Large imports publish in a separate action without acquisition buffers or LFS rules.
const archivePublicationFiles = 65_536;
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
  // A complete checkpoint needs no GitHub acquisition credentials or source request.
  if (await resumePublication(ctx, job, input, meter)) return;
  const started = Date.now(),
    cursor = archiveCursorSchema.parse(JSON.parse(job.cursor));
  logImportMetric({ projectId: job.projectId, phase: 'archive-start', step: job.step, at: started });
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
  const ready = await jobListing(ctx, job, input, cursor.tree, token, github, meter, !cursor.pins);
  if (!ready) return;
  try {
    await runListedArchiveImport(ctx, job, input, meter, ready, {
      started,
      cursor,
      github,
      token,
      privateRepository: access.repository.private,
    });
  } finally {
    // Publication may already have selected main. A scratch close cannot undo it.
    await ready.close().catch(() => {});
  }
}

async function runListedArchiveImport(
  ctx: ActionCtx,
  job: Doc<'projectGithubImports'>,
  input: Identity,
  meter: ImportRequestMeter,
  ready: NonNullable<Awaited<ReturnType<typeof jobListing>>>,
  {
    started,
    cursor,
    github,
    token,
    privateRepository,
  }: {
    started: number;
    cursor: ReturnType<typeof archiveCursorSchema.parse>;
    github: ReturnType<ImportRequestMeter['wrap']>;
    token: string | undefined;
    privateRepository: boolean;
  },
) {
  const { listing, pin: listingPin } = ready;
  logImportMetric({
    projectId: job.projectId,
    phase: 'listing',
    at: Date.now(),
    elapsedMillis: Date.now() - started,
    files: listing.length,
    sourceBytes: listing.totalBytes,
  });
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
  // Pins by listing row: columns, not a path Map (memory per file bounds the import size).
  const imported =
    (cursor.pins && (await readPins(job.projectId, cursor.pins, cursor.tree, listingPin, listing.length))) ||
    new ImportedPins(listing.length);
  let bytes = 0;
  let lfsBytes = 0;
  const lfsOids = new Set<string>();
  if (cursor.pins)
    for await (const page of listing.pages())
      imported.retain(
        index => {
          const blob = imported.blob(index),
            size = imported.size(index);
          if (stored.sizeOf(blob) !== size) return false;
          if (page.mode(index - page.start) !== '160000') bytes += size;
          if (imported.isLfs(index) && !lfsOids.has(blob)) {
            lfsOids.add(blob);
            lfsBytes += size;
          }
          return true;
        },
        page.start,
        page.start + page.length,
      );
  const initialCount = imported.count;
  const counters = () => ({
    completed: imported.count,
    total: listing.length,
    bytes,
    // LFS objects replace their pointers' listed bytes once resolved.
    totalBytes: Math.max(listing.totalBytes, bytes),
    submodules: listing.submodules,
  });
  const publish = async () => {
    await publishImport(
      ctx,
      { ...job, ...counters(), totalKnown: true },
      archiveRows(listing, () => imported),
      catalog,
      meter,
    );
    await dropListing(job.projectId);
  };
  // A complete checkpoint hands off directly to publication. If any pin was
  // lost, continue the ordinary acquisition path and verify those rows again.
  if (cursor.pins && initialCount === listing.length) {
    logImportMetric({
      projectId: job.projectId,
      phase: 'publication-handoff',
      step: job.step,
      at: Date.now(),
      files: initialCount,
    });
    await publish();
    return;
  }
  const upload = new ImportUpload(ctx, job.projectId, job.owner, archiveUploadConcurrency, catalog);
  const record = (entry: ListedGithubEntry, pin: { blob: string; size: number }, lfs?: true) => {
    if (imported.has(entry.row)) return;
    imported.set(entry.row, pin.blob, pin.size, lfs);
    if (entry.mode !== '160000') bytes += pin.size;
  };
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
    entry: ListedGithubEntry,
    read: (consume: (part: Buffer) => Promise<void>) => Promise<void>,
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
    record(entry, pin);
    return true;
  };
  const limit = cursor.lfsLimitBytes ?? lfsImportDefaultBytes;
  const lfs = new LfsImport<ListedGithubEntry>(limit, {
    carried: lfsBytes,
    previouslyCounted: oid => lfsOids.has(oid),
  });
  const fallback = {
    upload,
    fetchBlobs: (entries: GithubSourceEntry[]) => githubBlobPack(job.repository, entries, token, github),
    record,
    drain,
    over,
    hold: lfs.hold.bind(lfs),
  };
  const missing = async function* (kind: 'gitlink' | 'small' | 'large') {
    for await (const page of listing.pages()) {
      for (let row = 0; row < page.length; row++) {
        if (imported.has(page.start + row)) continue;
        const mode = page.mode(row);
        const rowKind =
          mode === '160000' ? 'gitlink' : page.size(row) <= objectChunkBytes ? 'small' : 'large';
        if (kind === rowKind && !lfs.isHeld(page.path(row))) yield page.entry(row);
      }
    }
  };
  const attributes = async function* () {
    for await (const page of listing.pages()) {
      for (let row = 0; row < page.length; row++) {
        const mode = page.mode(row);
        if (
          page.size(row) <= lfsAttributeBytes &&
          (mode === '100644' || mode === '100755') &&
          isGitattributesPath(page.path(row))
        )
          yield page.entry(row);
      }
    }
  };
  const stageMissing = async (pageFiles?: number) => {
    // Gitlinks and large blobs use separate passes so their presence cannot
    // fragment packs of small blobs, regardless of where they sort.
    for await (const entry of missing('gitlink')) {
      if (cursor.pins && over()) break;
      const pin = upload.put(Buffer.from(entry.sha));
      record(entry, { blob: pin.sha256, size: pin.size });
      await drain();
    }
    // Once we hold pointers, leave space for LFS to resolve them in this action.
    const sourceOver = () =>
      over() ||
      Boolean(cursor.pins && lfs.holding && Date.now() - started >= archiveRunMillis - packTimeoutMillis);
    await stageFallbackBlobs(missing('small'), { ...fallback, over: sourceOver }, pageFiles);
    for await (const entry of missing('large')) {
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
      const selected =
        current.protocol === 3
          ? archiveCursorSchema.parse(JSON.parse(current.cursor)).pins?.sha256
          : undefined;
      if (selected !== pins.sha256) await dropImportScratch(job.projectId, pins);
      if (selected !== cursor.pins?.sha256) await dropImportScratch(job.projectId, cursor.pins);
    }
  };
  try {
    if (cursor.pins) {
      // Every rule must be present even when the file that defines it is pinned.
      if (limit) await stageFallbackBlobs(attributes(), fallback, importPageFiles);
      await stageMissing(importPageFiles);
    } else {
      const archive = await openGithubArchive(job.repository, job.commit, token, github);
      logImportMetric({
        projectId: job.projectId,
        phase: 'archive-open',
        at: Date.now(),
        elapsedMillis: Date.now() - started,
      });
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
            record(file.entry, { blob: pin.sha256, size: pin.size });
          }
        } else await streamLarge(file.entry, file.read!);
        await drain();
      }
      if (complete && imported.count < listing.length) await stageMissing();
    }
    if (!over() || (cursor.pins && lfs.holding))
      await lfs.resolve({
        repository: job.repository,
        // Public repositories read LFS anonymously; private ones use the import token.
        ...(privateRepository ? { token } : {}),
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
    logImportMetric({
      projectId: job.projectId,
      phase: 'archive-complete',
      step: job.step,
      at: Date.now(),
      elapsedMillis: Date.now() - started,
      files: imported.count,
      lfsObjects: lfs.objects,
      lfsBytes: lfs.objectBytes,
      lfsFetched: lfs.fetched,
      putAttempts: upload.putAttempts,
      putBytes: upload.putBytes,
      uploadMillis: upload.uploadMillis,
      peakBufferedBytes: upload.peakBufferedBytes,
    });
    if (imported.count < listing.length) {
      invariant(
        !cursor.pins || imported.count > initialCount,
        'GITHUB_ARCHIVE_TOO_LARGE',
        'This import step verified no new files. Retry from its saved progress.',
      );
      await checkpoint(true);
      return;
    }
    if (imported.count >= archivePublicationFiles) {
      await checkpoint(true);
      return;
    }
    await publish();
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
        logImportMetric({
          projectId: job.projectId,
          phase: 'checkpoint-failed',
          reason: checkpointError instanceof Error ? checkpointError.name : 'UNKNOWN',
        });
      }
    throw error;
  }
}
