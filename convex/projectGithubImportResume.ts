// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
'use node';
import { logImportMetric } from '../src/github-import-metric';
import type { ActionCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { ForgeError } from '../src/errors';
import { CatalogTable } from '../src/import-catalog-table';
import type { ImportRequestMeter } from '../src/github-import-meter';
import { windowEntries } from './projectGithubImportCatalog';
import type { CatalogEntry } from './projectGithubImportUpload';
import { publishImport } from './projectGithubImportPublish';
import { dropListing, readListing } from './projectGithubImportListing';
import { archiveCursorSchema } from '../src/github-import-pages';
import { completeArchiveRows } from './projectGithubImportRows';
import { rowsFromState } from './projectGithubImportStateRows';

type Identity = { id: Id<'projectGithubImports'>; actor: string };

/** One receipt per stored upload window. */
export async function storedObjects(ctx: ActionCtx, input: Identity, step?: number) {
  const stored = new CatalogTable();
  for (let after = ''; ;) {
    const rows = await ctx.runQuery(internal.projectGithubImportCatalog.stored, {
      ...input,
      after,
      ...(step === undefined ? {} : { step }),
    });
    if (!rows.length) break;
    for (const row of rows) for (const entry of windowEntries(row.value)) stored.set(entry.digest, entry);
    after = rows.at(-1)!.key;
  }
  return stored;
}

/** Paged imports keep the existing file cursor and commit its verified pins
 * alongside it. A streamed object can checkpoint earlier physical windows. */
export function pagedUploadCatalog(
  ctx: ActionCtx,
  job: Doc<'projectGithubImports'>,
  stored: CatalogTable,
  lfsOids?: Set<string>,
) {
  return {
    stored,
    rawChunks: true,
    ...(lfsOids && job.completed > 0
      ? {
          known: (digests: string[]) =>
            ctx.runQuery(internal.projectGithubImportInventory.storedBlobs, {
              id: job._id,
              actor: job.owner,
              digests,
            }),
        }
      : {}),
    record: async (objects: CatalogEntry[]) => {
      await ctx.runMutation(internal.projectGithubImportStore.archiveProgress, {
        id: job._id,
        actor: job.owner,
        step: job.step,
        completed: job.completed,
        total: job.total,
        bytes: job.bytes,
        totalBytes: job.totalBytes,
        submodules: job.submodules ?? 0,
        objects,
        ...(lfsOids?.size
          ? { lfsOids: objects.filter(entry => lfsOids.has(entry.digest)).map(entry => entry.digest) }
          : {}),
      });
    },
  };
}

/** Publish a complete archive from its verified checkpoint, or retry with
 * verified State ranges if the checkpoint is unavailable. */
export async function resumePublication(
  ctx: ActionCtx,
  job: Doc<'projectGithubImports'>,
  input: Identity,
  meter: ImportRequestMeter,
) {
  if (!job.totalKnown || job.completed !== job.total) return false;
  const cursor = archiveCursorSchema.parse(JSON.parse(job.cursor));
  const listingPin = job.listing;
  let ready =
    cursor.pins &&
    listingPin &&
    (await readListing(job.projectId, listingPin, cursor.tree, false).catch(() => null));
  const pin = job.stateObject;
  if (!ready && !pin) return false;
  try {
    if (ready)
      logImportMetric({
        projectId: job.projectId,
        phase: 'listing',
        at: Date.now(),
        files: ready.listing.length,
        sourceBytes: ready.listing.totalBytes,
      });
    const stored = await storedObjects(ctx, input);
    let source;
    try {
      const checkpoint =
        ready &&
        cursor.pins &&
        listingPin &&
        (await completeArchiveRows(job, ready.listing, listingPin, cursor.tree, cursor.pins, stored).catch(
          () => null,
        ));
      if (!checkpoint && !pin) return false;
      if (!checkpoint && ready) {
        await ready.close().catch(() => {});
        ready = null;
      }
      source = checkpoint || (await rowsFromState(job, stored, pin!));
      logImportMetric({
        projectId: job.projectId,
        phase: pin ? 'resume' : 'publication-handoff',
        step: job.step,
        at: Date.now(),
        files: job.total,
        source: checkpoint ? 'pins' : 'state',
      });
    } catch (error) {
      logImportMetric({
        projectId: job.projectId,
        phase: 'resume-fallback',
        at: Date.now(),
        reason: error instanceof ForgeError ? error.code : 'UNREADABLE',
      });
      return false;
    }
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
    try {
      await publishImport(ctx, job, source.rows, { stored, record }, meter);
      await dropListing(job.projectId);
      return true;
    } finally {
      await source.close().catch(() => {});
    }
  } finally {
    if (ready) await ready.close().catch(() => {});
  }
}
