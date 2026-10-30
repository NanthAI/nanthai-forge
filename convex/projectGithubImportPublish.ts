// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';
import { ImportUpload } from './projectGithubImportUpload';
import { githubImportedWork, type GithubHostedFile } from '../src/hosted-github-bootstrap';
import { materializeWork, type IndexEntry } from '../src/work-hosted-index';
import { sourceTreeEntries } from '../src/source-tree-index';
import { nativeManifestSchema } from '../src/work-archive-metadata';
import { digest } from '../src/hash';
import { authorizeGithub } from '../src/github-access';
import { githubConfig } from './access';
import { invariant } from '../src/errors';

/** Metadata is traversed in bounded ordered pages. No whole repository array,
 * State string, manifest string or projection crosses an RPC boundary. */
export async function publishImport(ctx: ActionCtx, job: Doc<'projectGithubImports'>) {
  const identity = { id: job._id, actor: job.owner };
  async function* pages(part: string) {
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
  const upload = new ImportUpload(ctx, job.projectId, job.owner);
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
  const parents = Object.assign(new Map([[head, [] as string[]]]), { files: new Map([[head, []]]) });
  const projection = materializeWork(data, minimal, [], 'objects', parents);
  projection.metadata.counts.sourceBlobs = blobs + 1;
  for (const row of projection.entries)
    if (row.collection === 'sourceTrees') row.value = JSON.stringify({ head, files: job.total });
  await ctx.runMutation(internal.projectGithubImportPublication.begin, {
    ...identity,
    step: job.step,
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
  let batch = 0;
  const stage = async (entries: IndexEntry[]) => {
    await ctx.runMutation(internal.projectGithubImportPublication.stage, {
      ...identity,
      batch: batch++,
      entries,
    });
  };
  await stage(projection.entries);
  let position = 0;
  for await (const rows of pages('imported')) {
    const paths = sourceTreeEntries(
      head,
      rows.map(row => JSON.parse(row.value)),
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
  position = 1;
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
