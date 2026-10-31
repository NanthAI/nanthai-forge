// SPDX-License-Identifier: Apache-2.0
'use node';
import { createHash } from 'node:crypto';
import type { ActionCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { authorizeGithub } from '../src/github-access';
import { githubConfig } from './access';
import { importReadToken } from './githubAppToken';
import {
  githubSourceMode,
  streamGithubSourceBlob,
  type GithubSourceEntry,
} from '../src/github-project-source';
import {
  listGithubTree,
  openGithubArchive,
  githubArchiveFiles,
  gitBlobId,
} from '../src/github-archive-source';
import { archiveCursorSchema, importPathKey } from '../src/github-import-pages';
import { ObjectRecipeBuilder, objectChunkBytes } from '../src/object-chunks';
import { mapExchange } from '../src/exchange-parallel';
import { digest } from '../src/hash';
import { invariant } from '../src/errors';
import { ImportUpload, type CatalogEntry } from './projectGithubImportUpload';
import { windowEntries } from './projectGithubImportCatalog';
import { publishImport, type ImportRows } from './projectGithubImportPublish';
import type { GithubHostedFile } from '../src/hosted-github-bootstrap';

/** A run stops streaming here and continues in a fresh action; the platform
 * action limit is 10 minutes and publication needs headroom. */
export const archiveRunMillis = 6 * 60_000;
/** R2 PUTs are independent and latency-bound; source bytes stay inside the
 * 8 MiB upload window regardless of this count. */
export const archiveUploadConcurrency = 32;

type Identity = { id: Id<'projectGithubImports'>; actor: string };
/** Bytes cross the network once: GitHub archive -> verified -> content-addressed
 * R2 objects. Convex sees one prepare and one completion per 1,000-object page;
 * no per-file inventory row is written. Every file is proven against its Git
 * object ID from the listed commit tree before it can enter the State. */
export async function runArchiveImport(ctx: ActionCtx, job: Doc<'projectGithubImports'>, input: Identity) {
  const started = Date.now(),
    cursor = archiveCursorSchema.parse(JSON.parse(job.cursor));
  const access = await authorizeGithub(job.repository, job.owner, githubConfig());
  invariant(
    job.visibility === 'private' || !access.repository.private,
    'GITHUB_VISIBILITY_CHANGED',
    'Repository visibility changed during import; main was not published.',
  );
  const token =
    (await importReadToken(access.repository.full_name, (access.repository as { id?: unknown }).id)) ??
    access.token;
  const listing = await listGithubTree(job.repository, cursor.tree, token);
  invariant(listing, 'GITHUB_RESPONSE', 'GitHub no longer lists this commit tree completely.');
  const listed = new Map(listing.files.map(file => [file.path, file]));
  // Progress is the stored objects themselves: one receipt per earlier window.
  const stored = new Map<string, CatalogEntry>();
  for (let after = ''; ;) {
    const rows = await ctx.runQuery(internal.projectGithubImportCatalog.stored, { ...input, after });
    if (!rows.length) break;
    for (const row of rows) for (const entry of windowEntries(row.value)) stored.set(entry.digest, entry);
    after = rows.at(-1)!.key;
  }
  const saveWindow = async (objects: CatalogEntry[]) => {
    await ctx.runMutation(internal.projectGithubImportStore.archiveProgress, {
      ...input,
      step: job.step,
      ...counters(),
      objects,
    });
  };
  const catalog = { stored, record: saveWindow };
  const upload = new ImportUpload(ctx, job.projectId, job.owner, archiveUploadConcurrency, catalog);
  const imported = new Map<string, GithubHostedFile>();
  let bytes = 0;
  const record = (entry: GithubSourceEntry, pin: { blob: string; size: number }) => {
    imported.set(entry.path, {
      path: entry.path,
      blob: pin.blob,
      size: pin.size,
      mode: githubSourceMode(entry.mode),
    });
    if (entry.mode !== '160000') bytes += pin.size;
  };
  const counters = () => ({
    completed: imported.size,
    total: listing.files.length,
    bytes,
    totalBytes: listing.totalBytes,
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
  let complete = true;
  const archive = await openGithubArchive(job.repository, job.commit, token);
  for await (const file of githubArchiveFiles(archive, listed, objectChunkBytes)) {
    if (file.bytes) {
      if (gitBlobId(file.entry.sha, file.bytes) === file.entry.sha) {
        const pin = upload.put(file.bytes);
        record(file.entry, { blob: pin.sha256, size: pin.size });
      }
    } else await streamLarge(file.entry, file.read!);
    await drain();
    if (over()) {
      complete = false;
      break;
    }
  }
  // Members the archive omitted or rewrote, and gitlink pointers, by Git object.
  const missing = complete ? listing.files.filter(file => !imported.has(file.path)) : [];
  for (const entry of missing.filter(file => file.mode === '160000')) {
    const pointer = Buffer.from(entry.sha);
    upload.put(pointer);
    record(entry, { blob: digest(pointer), size: pointer.length });
  }
  const small = missing.filter(file => file.mode !== '160000' && file.size <= objectChunkBytes);
  for (let at = 0; at < small.length && !over(); at += 100) {
    const page = small.slice(at, at + 100);
    const fetched = await mapExchange(page, 8, async entry => {
      const parts: Buffer[] = [];
      const pin = await streamGithubSourceBlob(
        job.repository,
        entry,
        async part => {
          parts.push(part);
        },
        token,
      );
      return { pin, bytes: Buffer.concat(parts) };
    });
    for (const [index, entry] of page.entries()) {
      upload.put(fetched[index]!.bytes);
      record(entry, fetched[index]!.pin);
    }
    await drain();
  }
  for (const entry of missing.filter(file => file.mode !== '160000' && file.size > objectChunkBytes)) {
    if (over()) break;
    const matched = await streamLarge(entry, async consume => {
      await streamGithubSourceBlob(job.repository, entry, consume, token);
    });
    invariant(matched, 'ARTIFACT_INTEGRITY', 'GitHub blob differs from the selected commit.');
  }
  await drain(true);
  await flush();
  if (imported.size < listing.files.length || over()) {
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
    });
    return;
  }
  const rows: ImportRows = { imported: [], blobs: [] };
  const blobs = new Map<string, number>();
  for (const file of listing.files) {
    const value = imported.get(file.path)!;
    rows.imported.push({
      key: importPathKey(file.path),
      value: JSON.stringify({ path: value.path, blob: value.blob, size: value.size, mode: value.mode }),
    });
    blobs.set(value.blob, value.size);
  }
  for (const [sha256, size] of [...blobs].sort(([a], [b]) => (a < b ? -1 : 1)))
    rows.blobs.push({ key: sha256, value: JSON.stringify({ sha256, size }) });
  await publishImport(ctx, { ...job, ...counters(), totalKnown: true }, rows, catalog);
}
