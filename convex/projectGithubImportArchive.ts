// SPDX-License-Identifier: Apache-2.0
'use node';
import { createHash } from 'node:crypto';
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
import { archiveCursorSchema, importPageBytes, lfsImportDefaultBytes } from '../src/github-import-pages';
import { ImportedPins } from '../src/github-listing-codec';
import { ObjectRecipeBuilder, objectChunkBytes } from '../src/object-chunks';
import { githubBlobPack } from '../src/github-blob-pack';
import { streamGithubBlobPack } from '../src/github-blob-pack-stream';
import { digest } from '../src/hash';
import { invariant } from '../src/errors';
import { LfsImport } from '../src/github-lfs-import';
import { ImportUpload, type CatalogEntry } from './projectGithubImportUpload';
import { resumePublication, storedObjects } from './projectGithubImportResume';
import { dropListing, jobListing } from './projectGithubImportListing';
import { publishImport, type ImportRows } from './projectGithubImportPublish';

/** A run stops streaming here and continues in a fresh action; the platform
 * action limit is 10 minutes and publication needs headroom. */
export const archiveRunMillis = 6 * 60_000;
/** Pack and empty-object PUTs may proceed independently within the bounded
 * source window and pack-copy memory. */
export const archiveUploadConcurrency = 32;

type Identity = { id: Id<'projectGithubImports'>; actor: string };
/** Bytes cross the network once: GitHub archive -> verified -> content-addressed
 * R2 packs. Convex sees one compact receipt per bounded upload window;
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
  const access = await authorizeImportGithub(job.repository, job.owner, github);
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
  invariant(listing, 'GITHUB_RESPONSE', 'GitHub no longer lists this commit tree completely.');
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
  const imported = new ImportedPins(listing.length);
  let bytes = 0;
  const record = (
    entry: GithubSourceEntry,
    pin: { blob: string; size: number },
    index = listing.index(entry.path),
  ) => {
    invariant(index >= 0, 'GITHUB_RESPONSE', 'GitHub returned a file outside the listed tree.');
    if (imported.has(index)) return;
    imported.set(index, pin.blob, pin.size);
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
  const flush = () => saveWindow(upload.catalogReceipt());
  const drain = async (force = false) => {
    if (await upload.drain(force)) await flush();
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
    record(entry, pin, index);
    return true;
  };
  // Pointer-shaped files wait until every .gitattributes is known (filter=lfs).
  const lfs = new LfsImport(cursor.lfsLimitBytes ?? lfsImportDefaultBytes);
  let complete = true;
  const archive = await openGithubArchive(job.repository, job.commit, token, github);
  console.log(
    `FORGE_IMPORT_METRIC ${JSON.stringify({ projectId: job.projectId, phase: 'archive-open', at: Date.now(), elapsedMillis: Date.now() - started })}`,
  );
  let seen = 0;
  for await (const file of githubArchiveFiles(archive, listing, objectChunkBytes)) {
    // Stop before the next member, not after the last: a run that read the whole
    // archive at the budget still publishes instead of streaming it all again.
    if (seen++ && over()) {
      complete = false;
      break;
    }
    if (file.bytes) {
      if (gitBlobId(file.entry.sha, file.bytes) === file.entry.sha && !lfs.hold(file.entry, file.bytes)) {
        const pin = upload.put(file.bytes);
        record(file.entry, { blob: pin.sha256, size: pin.size }, file.index);
      }
    } else await streamLarge(file.entry, file.read!, file.index);
    await drain();
  }
  // Members the archive omitted or rewrote, and gitlink pointers, by Git object.
  const missing: GithubSourceEntry[] = [];
  for (let index = 0; complete && index < listing.length; index++)
    if (!imported.has(index) && !lfs.isHeld(listing.path(index))) missing.push(listing.entry(index));
  for (const entry of missing.filter(file => file.mode === '160000')) {
    const pointer = Buffer.from(entry.sha);
    upload.put(pointer);
    record(entry, { blob: digest(pointer), size: pointer.length });
  }
  await stageFallbackBlobs(
    missing.filter(file => file.mode !== '160000' && file.size <= objectChunkBytes),
    {
      upload,
      fetchBlobs: entries => githubBlobPack(job.repository, entries, token, github),
      record,
      drain,
      over,
      hold: lfs.hold.bind(lfs),
    },
  );
  for (const entry of missing.filter(file => file.mode !== '160000' && file.size > objectChunkBytes)) {
    if (over()) break;
    const matched = await streamLarge(entry, async consume => {
      await streamGithubBlobPack(job.repository, entry, consume, token, github);
    });
    invariant(matched, 'ARTIFACT_INTEGRITY', 'GitHub blob differs from the selected commit.');
  }
  if (complete && !over())
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
      over,
    });
  await drain(true);
  await flush();
  console.log(
    `FORGE_IMPORT_METRIC ${JSON.stringify({ projectId: job.projectId, phase: 'archive-complete', at: Date.now(), elapsedMillis: Date.now() - started, files: imported.size, lfsObjects: lfs.objects, lfsBytes: lfs.objectBytes, lfsFetched: lfs.fetched, putAttempts: upload.putAttempts, putBytes: upload.putBytes, uploadMillis: upload.uploadMillis, peakBufferedBytes: upload.peakBufferedBytes, rssBytes: process.memoryUsage().rss })}`,
  );
  if (imported.count < listing.length || !complete) {
    // Progress is the stored objects themselves; a continuation skips them.
    // A run that stored nothing new cannot converge within an action.
    invariant(
      upload.uploaded > 0 || cursor.runs === 0,
      'GITHUB_ARCHIVE_TOO_LARGE',
      'This repository archive cannot be streamed within one import run. Main was not published.',
    );
    await ctx.runMutation(internal.projectGithubImportStore.advance, {
      ...input,
      step: job.step,
      cursor: JSON.stringify({ ...cursor, runs: cursor.runs + 1 }),
      ...counters(),
      discovering: false,
      githubRequests: meter.counts,
    });
    return;
  }
  // Rows are produced page by page while publication reads them: 100,000 files
  // as materialized JSON rows held about 190 MB of a 512 MB action.
  const rows: ImportRows = {
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
  await publishImport(ctx, { ...job, ...counters(), totalKnown: true }, rows, catalog, meter);
  await dropListing(job.projectId, listingPin);
}

/** Fallback blobs (omitted or rewritten archive members) are fetched in windows
 * sized by listed bytes as well as count: a window only fills the room left
 * before the normal 8 MiB drain threshold, plus at most one blob when it is
 * empty. One Git fetch returns the verified page; staging drains after each
 * byte-bounded page, so neither transfer nor staging grows with the repository. */
export async function stageFallbackBlobs(
  entries: GithubSourceEntry[],
  io: {
    upload: Pick<ImportUpload, 'put' | 'stagedBytes'>;
    fetchBlobs: (entries: GithubSourceEntry[]) => Promise<Map<string, Buffer>>;
    record: (entry: GithubSourceEntry, pin: { blob: string; size: number }) => void;
    drain: () => Promise<void>;
    over: () => boolean;
    /** True when these verified bytes wait for LFS resolution instead. */
    hold?: (entry: GithubSourceEntry, bytes: Buffer) => boolean;
  },
  pageFiles = 100,
) {
  for (let at = 0; at < entries.length && !io.over();) {
    const room = importPageBytes - io.upload.stagedBytes;
    let end = at,
      listed = 0;
    while (
      end < entries.length &&
      end - at < pageFiles &&
      (end === at || listed + entries[end]!.size <= room)
    )
      listed += entries[end++]!.size;
    const page = entries.slice(at, end),
      blobs = await io.fetchBlobs(page);
    for (const entry of page) {
      const bytes = blobs.get(entry.sha);
      invariant(
        bytes && bytes.length === entry.size && gitBlobId(entry.sha, bytes) === entry.sha,
        'ARTIFACT_INTEGRITY',
        'GitHub blob differs from the selected commit.',
      );
      if (io.hold?.(entry, bytes)) continue;
      io.upload.put(bytes);
      io.record(entry, { blob: digest(bytes), size: bytes.length });
    }
    at = end;
    await io.drain();
  }
}
