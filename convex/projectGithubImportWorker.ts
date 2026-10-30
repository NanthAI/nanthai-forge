// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { authorizeGithub } from '../src/github-access';
import { githubConfig } from './access';
import {
  discoverGithubSource,
  githubSourceMode,
  streamGithubSourceBlob,
  type GithubSourceEntry,
} from '../src/github-project-source';
import { ObjectRecipeBuilder, objectChunkBytes } from '../src/object-chunks';
import { ForgeError, invariant } from '../src/errors';
import { mapExchange } from '../src/exchange-parallel';
import {
  importPageFiles,
  importPageBytes,
  importPageMillis,
  importPageMetadataBytes,
  importPathKey,
  type ImportProgress,
} from '../src/github-import-pages';
import { ImportUpload } from './projectGithubImportUpload';
import { publishImport } from './projectGithubImportPublish';
export const run = internalAction({
  args: { id: v.id('projectGithubImports'), actor: v.string() },
  returns: v.null(),
  handler: async (ctx, input): Promise<null> => {
    const { job, entries } = await ctx.runQuery(internal.projectGithubImportInventory.page, input);
    if (job.phase === 'ready') return null;
    try {
      invariant(
        job.protocol === 2,
        'IMPORT_RESTART_REQUIRED',
        `This legacy import cannot resume after the paged-import upgrade. Restart Import from GitHub for ${job.repository} at commit ${job.commit} with a new operation UUID: npx convex run projectGithubImport:start '${JSON.stringify({ url: job.repository, ref: job.commit, operationId: crypto.randomUUID() })}'. The partial project has no published main.`,
      );
      const progress: ImportProgress = JSON.parse(job.cursor);
      invariant(progress.schema === 2, 'IMPORT_CURSOR_CHANGED', 'Import progress format differs.');
      const access = await authorizeGithub(job.repository, job.owner, githubConfig());
      invariant(
        job.visibility === 'private' || !access.repository.private,
        'GITHUB_VISIBILITY_CHANGED',
        'Repository visibility changed during import; main was not published.',
      );
      const started = Date.now();
      if (!job.totalKnown) {
        let total = job.total,
          totalBytes = job.totalBytes,
          submodules = job.submodules ?? 0,
          size = 0;
        let staged: { part: string; key: string; position: number; value: string }[] = [];
        let stagedBytes = 0;
        const flush = async () => {
          if (staged.length) {
            await ctx.runMutation(internal.projectGithubImportInventory.stage, {
              ...input,
              step: job.step,
              entries: staged,
            });
            staged = [];
            stagedBytes = 0;
          }
        };
        const append = async (entry: (typeof staged)[number]) => {
          const size = Buffer.byteLength(JSON.stringify(entry));
          if (
            staged.length &&
            (staged.length >= importPageFiles || stagedBytes + size > importPageMetadataBytes)
          )
            await flush();
          staged.push(entry);
          stagedBytes += size;
        };
        for (const entry of entries) {
          const directory = JSON.parse(entry.value);
          const next = await discoverGithubSource(
            {
              schema: 1,
              repository: job.repository,
              commit: job.commit,
              pending: [directory],
              files: [],
              completed: 0,
              bytes: 0,
              totalBytes: 0,
            },
            access.token,
          );
          for (const child of next.pending) {
            await append({
              part: 'directories',
              key: child.path,
              position: progress.discovered++,
              value: JSON.stringify(child),
            });
          }
          for (const file of next.files) {
            invariant(
              !file.path
                .toLowerCase()
                .split('/')
                .some(part => ['.git', '.forge'].includes(part)),
              'INVALID_NATIVE_SOURCE',
              'Imported paths cannot overlap native metadata.',
            );
            await append({
              part: 'files',
              key: importPathKey(file.path),
              position: 0,
              value: JSON.stringify(file),
            });
          }
          total += next.files.length;
          totalBytes += next.totalBytes;
          submodules += next.submodules ?? 0;
          size += Buffer.byteLength(JSON.stringify(next));
          progress.directories++;
          if (
            size >= importPageBytes ||
            total - job.total >= importPageFiles ||
            Date.now() - started >= importPageMillis
          )
            break;
        }
        await flush();
        await ctx.runMutation(internal.projectGithubImportStore.advance, {
          ...input,
          step: job.step,
          cursor: JSON.stringify(progress),
          completed: job.completed,
          total,
          bytes: job.bytes,
          totalBytes,
          submodules,
          discovering: progress.directories < progress.discovered,
        });
      } else if (job.completed < job.total) {
        const upload = new ImportUpload(ctx, job.projectId, job.owner);
        const imported: { part: string; key: string; position: number; value: string }[] = [];
        let bytes = job.bytes,
          completed = job.completed;
        const smallPage = entries.every(row => JSON.parse(row.value).size <= objectChunkBytes);
        const fetched = smallPage
          ? await mapExchange(entries, 8, async row => {
              if (Date.now() - started >= importPageMillis) return null;
              const file: GithubSourceEntry = JSON.parse(row.value),
                parts: Buffer[] = [];
              const pin = await streamGithubSourceBlob(
                job.repository,
                file,
                async part => {
                  parts.push(part);
                },
                access.token,
              );
              return { pin, bytes: Buffer.concat(parts) };
            })
          : null;
        for (const [index, row] of entries.entries()) {
          const file: GithubSourceEntry = JSON.parse(row.value);
          if (fetched && !fetched[index]) break;
          let pin;
          if (fetched) {
            pin = fetched[index]!.pin;
            upload.put(fetched[index]!.bytes);
          } else if (file.size <= objectChunkBytes) {
            const parts: Buffer[] = [];
            pin = await streamGithubSourceBlob(
              job.repository,
              file,
              async part => {
                parts.push(part);
              },
              access.token,
            );
            upload.put(Buffer.concat(parts));
          } else {
            const builder = new ObjectRecipeBuilder(upload.put);
            pin = await streamGithubSourceBlob(
              job.repository,
              file,
              async part => {
                for (let offset = 0; offset < part.length; offset += 64 * 1024) {
                  builder.update(part.subarray(offset, offset + 64 * 1024));
                  if (await upload.drain()) await upload.commit();
                }
              },
              access.token,
            );
            upload.recipe(pin, builder.finish({ sha256: pin.blob, size: pin.size }).bytes);
          }
          const value = JSON.stringify({
            path: file.path,
            ...pin,
            mode: githubSourceMode(file.mode),
          });
          imported.push({ part: 'imported', key: row.key, position: completed++, value });
          bytes += file.mode === '160000' ? 0 : pin.size;
          progress.after = row.key;
          // A full byte window stops this page; a large single file streams
          // through multiple bounded physical windows before its logical receipt.
          if (bytes - job.bytes >= importPageBytes || (!fetched && Date.now() - started >= importPageMillis))
            break;
        }
        await upload.drain(true);
        await ctx.runMutation(internal.projectGithubImportStore.advance, {
          ...input,
          step: job.step,
          cursor: JSON.stringify(progress),
          completed,
          total: job.total,
          bytes,
          totalBytes: job.totalBytes,
          discovering: false,
          entries: imported,
          ...upload.receipt(),
        });
      } else await publishImport(ctx, job);
    } catch (error) {
      const known = error instanceof ForgeError;
      await ctx.runMutation(internal.projectGithubImportStore.fail, {
        ...input,
        step: job.step,
        code: known ? error.code : 'GITHUB_IMPORT_INTERRUPTED',
        message: known
          ? error.message
          : 'Import stopped before publication. Retry resumes the same commit and saved page.',
      });
    }
    return null;
  },
});
