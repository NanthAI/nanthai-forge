// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';
import { ImportUpload, type ImportCatalog } from './projectGithubImportUpload';
import { catalogPages } from './projectObjectFind';
import { githubImportedWork, type GithubHostedFile } from '../src/hosted-github-bootstrap';
import { materializeWork, type IndexEntry } from '../src/work-hosted-index';
import { sourceTreeEntries } from '../src/source-tree-index';
import { nativeManifestSchema } from '../src/work-archive-metadata';
import { digest } from '../src/hash';
import { authorizeGithub } from '../src/github-access';
import { githubConfig } from './access';
import { invariant } from '../src/errors';
import { importPageFiles } from '../src/github-import-pages';

const stagedPageBytes = 2 * 1024 * 1024;
/** ~35 KB rows: the web's 100-row record window stays a few MB at the archive limit. */
const treePathsPerRow = 500;
export type ImportRows = Record<'imported' | 'blobs', { key: string; value: string }[]>;
/** Metadata is traversed in bounded ordered pages. No whole repository array,
 * State string, manifest string or projection crosses an RPC boundary. Archive
 * imports pass their verified rows in key order instead of an inventory. */
export async function publishImport(
  ctx: ActionCtx,
  job: Doc<'projectGithubImports'>,
  memory?: ImportRows,
  catalog?: ImportCatalog,
) {
  const identity = { id: job._id, actor: job.owner };
  async function* pages(part: string) {
    if (memory) {
      const rows = memory[part as keyof ImportRows];
      for (let at = 0; at < rows.length; at += importPageFiles) yield rows.slice(at, at + importPageFiles);
      return;
    }
    let after = '';
    while (true) {
      const rows = await ctx.runQuery(internal.projectGithubImportInventory.scan, {
        ...identity,
        part,
        after,
      });
      if (!rows.length) return;
      after = rows.at(-1)!.key;
      yield rows;
    }
  }
  const upload = new ImportUpload(ctx, job.projectId, job.owner, 8, catalog);
  async function* stateBytes() {
    yield Buffer.from('{"schema":1,"kind":"forge-source-state","parents":[],"files":[');
    let first = true;
    for await (const rows of pages('imported')) {
      const values = rows.map(row => {
        const { path, blob, mode }: GithubHostedFile = JSON.parse(row.value);
        return JSON.stringify({ path, blob, mode });
      });
      yield Buffer.from((first ? '' : ',') + values.join(','));
      first = false;
    }
    yield Buffer.from(
      `],"message":${JSON.stringify(`Imported GitHub commit ${job.commit}`)},"at":${JSON.stringify(job.at)}}`,
    );
  }
  const state = await upload.stream(stateBytes()),
    head = state.sha256;
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
    coverage: `Complete committed GitHub tree at ${job.commit}; original file bytes, executable bits and symlink targets. Git history, LFS target objects and analysis are separate.`,
  });
  let blobs = 0;
  async function* manifestBytes() {
    const prefix = JSON.stringify(minimal),
      split = prefix.indexOf('],"unavailable"');
    yield Buffer.from(prefix.slice(0, split));
    for await (const rows of pages('blobs')) {
      blobs += rows.length;
      yield Buffer.from(
        rows
          .map(row => {
            const pin = JSON.parse(row.value);
            return ',' + JSON.stringify({ path: `objects/${pin.sha256}`, ...pin });
          })
          .join(''),
      );
    }
    yield Buffer.from(prefix.slice(split));
  }
  const root = await upload.stream(manifestBytes());
  if (catalog) {
    // Every stored object (sources, chunks, recipes, State, manifest) becomes a
    // sorted catalog row of objectCatalogPage pins: O(pages) documents, no row per object.
    const pages = catalogPages([...catalog.stored.values()]);
    for (const entry of catalog.stored.values())
      invariant(
        !entry.recipe || catalog.stored.has(entry.recipe.digest),
        'IMPORT_INCOMPLETE',
        'A recipe object is not stored.',
      );
    for (let at = 0; at < pages.length; at += 32)
      await ctx.runMutation(internal.projectGithubImportCatalog.publish, {
        ...identity,
        step: job.step,
        pages: pages.slice(at, at + 32),
      });
  }
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
  for await (const rows of pages('imported')) {
    const paths = sourceTreeEntries(
      head,
      rows.map(row => JSON.parse(row.value)),
      treePathsPerRow,
    );
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
    for await (const rows of pages('blobs')) {
      await stage(
        rows.map(row => ({
          collection: 'sourceBlobs',
          key: row.key,
          parent: '',
          position: position++,
          value: row.value,
        })),
      );
    }
  await flush();
  const access = await authorizeGithub(job.repository, job.owner, githubConfig());
  invariant(
    job.visibility === 'private' || !access.repository.private,
    'GITHUB_VISIBILITY_CHANGED',
    'Repository visibility changed during import; main was not published.',
  );
  await ctx.runMutation(internal.projectGithubImportPublication.finish, {
    ...identity,
    step: job.step,
    batches: batch,
  });
}
