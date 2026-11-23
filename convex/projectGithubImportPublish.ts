// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
'use node';
import { logImportMetric } from '../src/github-import-metric';
import type { ActionCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';
import { ImportUpload, type ImportCatalog } from './projectGithubImportUpload';
import { sortedCatalogPages } from './projectObjectFind';
import type { CatalogTable } from '../src/import-catalog-table';
import { githubImportedWork, type GithubHostedFile } from '../src/hosted-github-bootstrap';
import { materializeWork, type IndexEntry } from '../src/work-hosted-index';
import { sourceTreeEntries } from '../src/source-tree-index';
import { nativeManifestSchema } from '../src/work-archive-metadata';
import { digest } from '../src/hash';
import { authorizeImportGithub } from './githubImportAccess';
import { networkFetch } from '../src/network-fetch';
import { ImportRequestMeter } from '../src/github-import-meter';
import { ForgeError, invariant } from '../src/errors';
import { importPageFiles } from '../src/github-import-pages';
import { importStatePrefix, importStateSuffix } from '../src/import-state-scan';

const stagedPageBytes = 2 * 1024 * 1024;
/** ~35 KB rows: the web's 100-row record window stays a few MB at the archive limit. */
const treePathsPerRow = 500;
type ImportFile = Pick<GithubHostedFile, 'path' | 'blob' | 'size'> & { mode: string };
/** Repeatable scans in State order. Archive imports carry verified file pins
 * directly; only the legacy inventory needs to decode stored JSON rows. */
export type ImportRows = AsyncIterable<Iterable<ImportFile>>;
/** Publication sorts the catalog it stored in place, without copying it. */
type PublishCatalog = ImportCatalog & { stored: CatalogTable };
/** Metadata is traversed in bounded ordered pages. No whole repository array,
 * State string, manifest string or projection crosses an RPC boundary. Archive
 * imports pass their verified rows in key order instead of an inventory. */
export async function publishImport(
  ctx: ActionCtx,
  job: Doc<'projectGithubImports'>,
  memory?: ImportRows,
  catalog?: PublishCatalog,
  meter = new ImportRequestMeter(job.githubRequests),
) {
  try {
    await publishRows(ctx, job, memory, catalog, meter);
  } catch (error) {
    throw publicationFailure(error);
  }
}
/** A failure after every object is stored is a publication failure, not an interrupted
 * worker: it names its own code and what to do next. Errors a mutation throws reach the
 * action without their code, so anything uncoded is mapped here. */
export function publicationFailure(error: unknown) {
  if (error instanceof ForgeError) return error;
  const cause = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 240);
  return new ForgeError(
    'GITHUB_IMPORT_PUBLICATION_FAILED',
    `Publication failed after every source object was stored; main was not published (${cause}). Retry the original operation: it resumes publication from the stored objects and does not stream the archive again. If it fails again, report this code with the project id.`,
  );
}
async function publishRows(
  ctx: ActionCtx,
  job: Doc<'projectGithubImports'>,
  memory?: ImportRows,
  catalog?: PublishCatalog,
  meter = new ImportRequestMeter(job.githubRequests),
) {
  const started = Date.now();
  const metric = (phase: string) =>
    logImportMetric({
      projectId: job.projectId,
      phase,
      step: job.step,
      at: Date.now(),
      elapsedMillis: Date.now() - started,
      putAttempts: upload.putAttempts,
      putBytes: upload.putBytes,
      uploadMillis: upload.uploadMillis,
    });
  const identity = { id: job._id, actor: job.owner };
  async function* inventoryPages(part: 'imported' | 'blobs') {
    let after = '';
    while (true) {
      const rows = await ctx.runQuery(internal.projectGithubImportInventory.scan, {
        ...identity,
        part,
        after,
      });
      if (!rows.length) return;
      after = rows.at(-1)!.key;
      yield rows.map(row => row.value);
    }
  }
  async function* filePages() {
    if (!memory) {
      for await (const rows of inventoryPages('imported'))
        yield rows.map(row => JSON.parse(row) as ImportFile);
      return;
    }
    let page: ImportFile[] = [];
    for await (const range of memory)
      for (const row of range) {
        page.push(row);
        if (page.length < importPageFiles) continue;
        yield page;
        page = [];
      }
    if (page.length) yield page;
  }
  const upload = new ImportUpload(ctx, job.projectId, job.owner, 8, catalog);
  let fileCount = 0;
  async function* stateBytes() {
    yield importStatePrefix;
    let first = true;
    for await (const rows of filePages()) {
      fileCount += rows.length;
      const values = rows.map(({ path, blob, size, mode }) => {
        if (memory) catalog!.stored.markImportSource(blob, size);
        return JSON.stringify({ path, blob, mode });
      });
      yield Buffer.from((first ? '' : ',') + values.join(','));
      first = false;
    }
    yield importStateSuffix(job.commit, job.at);
  }
  const state = await upload.stream(stateBytes(), 1, !job.stateObject, () => fileCount),
    head = state.sha256;
  invariant(
    !memory || !job.stateObject || (head === job.stateObject.sha256 && state.size === job.stateObject.size),
    'INVALID_WORK_BACKUP',
    'Publication retry differs from the pinned State.',
  );
  const data = githubImportedWork(job.operationId, job.at, head);
  const workText = JSON.stringify(data, null, 2),
    work = { sha256: digest(workText), size: Buffer.byteLength(workText) };
  upload.put(Buffer.from(workText));
  await upload.drain(true);
  await upload.commit();
  const minimal = nativeManifestSchema.parse({
    schema: 1,
    kind: 'forge-native-work-backup',
    id: job.operationId,
    head,
    revision: 0,
    files: [
      { path: 'work.json', ...work },
      { path: `objects/${head}`, ...state },
    ],
    unavailable: [],
    coverage: `Complete committed GitHub tree at ${job.commit}; original file bytes, executable bits and symlink targets. ${lfsCoverage(job)} Git history and analysis are separate.`,
  });
  const catalogOrder = memory ? catalog!.stored.importOrder() : undefined;
  let blobs = 0;
  async function* manifestBytes() {
    const prefix = JSON.stringify(minimal),
      split = prefix.indexOf('],"unavailable"');
    yield Buffer.from(prefix.slice(0, split));
    if (catalogOrder) {
      let batch = [];
      for (const pin of catalogOrder.sources()) {
        blobs++;
        batch.push(manifestEntry(pin));
        if (batch.length < importPageFiles) continue;
        yield Buffer.from(batch.join(''));
        batch = [];
      }
      if (batch.length) yield Buffer.from(batch.join(''));
    } else
      for await (const rows of inventoryPages('blobs')) {
        blobs += rows.length;
        yield Buffer.from(
          rows
            .map(row => {
              const pin = JSON.parse(row);
              invariant(
                !catalog || catalog.stored.get(pin.sha256)?.size === pin.size,
                'IMPORT_INCOMPLETE',
                'A source blob is missing from the stored catalog.',
              );
              return manifestEntry(pin);
            })
            .join(''),
        );
      }
    yield Buffer.from(prefix.slice(split));
  }
  const root = await upload.stream(manifestBytes());
  metric('metadata');
  if (catalog) {
    // Every stored object (sources, chunks, recipes, State, manifest) becomes a
    // sorted catalog row of objectCatalogPage pins: O(pages) documents, no row per object.
    for (const entry of catalog.stored.values())
      invariant(
        !entry.recipe || catalog.stored.has(entry.recipe.digest),
        'IMPORT_INCOMPLETE',
        'A recipe object is not stored.',
      );
    // Packed pins carry a byte range. Keep paged-import RPCs inside their
    // existing payload budget even when every entry belongs to a pack.
    const pagesPerBatch = job.pagedCatalog ? 16 : 32;
    let pages = [];
    for (const page of sortedCatalogPages(catalogOrder?.entries() ?? catalog.stored.sorted())) {
      pages.push(page);
      if (pages.length < pagesPerBatch) continue;
      await ctx.runMutation(internal.projectGithubImportCatalog.publish, {
        ...identity,
        step: job.step,
        pages,
      });
      pages = [];
    }
    if (pages.length)
      await ctx.runMutation(internal.projectGithubImportCatalog.publish, {
        ...identity,
        step: job.step,
        pages,
      });
  }
  metric('catalog');
  const parents = Object.assign(new Map([[head, [] as string[]]]), { files: new Map([[head, []]]) });
  const projection = materializeWork(data, minimal, [], 'objects', parents);
  projection.metadata.counts.sourceBlobs = blobs + 1;
  for (const row of projection.entries)
    if (row.collection === 'sourceTrees') row.value = JSON.stringify({ head, files: job.total });
  await ctx.runMutation(internal.projectGithubImportPublication.begin, {
    ...identity,
    step: job.step,
    ...(catalog ? { objectCatalog: true } : {}),
    root,
    state,
    work,
    metadata: JSON.stringify(projection.metadata),
    preview: {
      manifestDigest: root.sha256,
      head,
      format: 'native',
      revision: 0,
      intents: 0,
      lanes: 0,
      views: 0,
      runs: 0,
      files: blobs + 2,
      unavailable: 0,
      channels: [{ name: 'main', head }],
    },
  });
  // Projection pages are bounded by entries and bytes, not one call per page.
  let batch = 0,
    staged: IndexEntry[] = [],
    stagedBytes = 0;
  const flush = async () => {
    if (!staged.length) return;
    await ctx.runMutation(internal.projectGithubImportPublication.stage, {
      ...identity,
      batch: batch++,
      entries: staged,
    });
    staged = [];
    stagedBytes = 0;
  };
  const stage = async (entries: IndexEntry[]) => {
    for (const entry of entries) {
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (staged.length >= 1000 || (staged.length && stagedBytes + size > stagedPageBytes)) await flush();
      staged.push(entry);
      stagedBytes += size;
    }
  };
  await stage(projection.entries);
  let position = 0;
  for await (const rows of filePages()) {
    const paths = sourceTreeEntries(head, rows, treePathsPerRow);
    await stage(
      paths
        .filter(row => row.collection !== 'sourceTrees')
        .map(row => ({
          ...row,
          key: `${head}:${position + row.position}`,
          position: position + row.position,
        })),
    );
    position += rows.length;
  }
  // Catalog-backed generations resolve sourceBlobs from the object catalog.
  position = 1;
  if (!catalog)
    for await (const rows of inventoryPages('blobs')) {
      await stage(
        rows.map(value => ({
          collection: 'sourceBlobs',
          key: JSON.parse(value).sha256,
          parent: '',
          position: position++,
          value,
        })),
      );
    }
  await flush();
  metric('projection');
  const access = await authorizeImportGithub(job.repository, job.owner, meter.wrap(networkFetch), ctx);
  invariant(
    job.visibility === 'private' || !access.repository.private,
    'GITHUB_VISIBILITY_CHANGED',
    'Repository visibility changed during import; main was not published.',
  );
  await ctx.runMutation(internal.projectGithubImportPublication.finish, {
    ...identity,
    step: job.step,
    batches: batch,
    githubRequests: meter.counts,
  });
  metric('ready');
}
function manifestEntry({ sha256, size }: { sha256: string; size: number }) {
  return ',' + JSON.stringify({ path: `objects/${sha256}`, sha256, size });
}

/** Archive and paged imports bind Git LFS paths to their objects unless the
 * importer chose pointers (limit 0). */
export function lfsCoverage(job: Pick<Doc<'projectGithubImports'>, 'protocol' | 'cursor'>) {
  const cursor =
    job.protocol === 3 || job.protocol === 2 ? (JSON.parse(job.cursor) as { lfsLimitBytes?: unknown }) : null;
  return cursor && cursor.lfsLimitBytes !== 0
    ? 'Git LFS paths (filter=lfs) hold their LFS object bytes.'
    : 'Git LFS pointers remain their committed bytes.';
}
