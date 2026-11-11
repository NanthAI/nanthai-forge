// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { authorizeImportGithub } from './githubImportAccess';
import { discoverGithubSource, githubSourceMode, type GithubSourceEntry } from '../src/github-project-source';
import { ObjectRecipeBuilder, objectChunkBytes } from '../src/object-chunks';
import { ForgeError, invariant } from '../src/errors';
import { githubBlobPack } from '../src/github-blob-pack';
import { streamGithubBlobPack } from '../src/github-blob-pack-stream';
import { digest } from '../src/hash';
import {
  importPageFiles,
  importPageBytes,
  importPageMillis,
  importPageMetadataBytes,
  importPathKey,
  lfsAttributeFiles,
} from '../src/github-import-pages';
import { isGitattributesPath, parseLfsPointer } from '../src/github-lfs';
import { lfsAttributeBytes } from '../src/github-lfs-import';
import { pagedLfs, resolvePageLfs } from './projectGithubImportLfs';
import type { ImportProgress } from '../src/github-import-pages';
import { ImportUpload } from './projectGithubImportUpload';
import { publishImport } from './projectGithubImportPublish';
import { runArchiveImport } from './projectGithubImportArchive';
import { importReadToken } from './githubAppToken';
import { convexFetch } from './networkFetch';
import { networkFetch } from '../src/network-fetch';
import { ImportRequestMeter } from '../src/github-import-meter';
export const run = internalAction({
  args: { id: v.id('projectGithubImports'), actor: v.string() },
  returns: v.null(),
  handler: async (ctx, input): Promise<null> => {
    const { job, entries } = await ctx.runQuery(internal.projectGithubImportInventory.page, input);
    if (job.phase === 'ready') return null;
    const meter = new ImportRequestMeter(job.githubRequests),
      github = meter.wrap(networkFetch);
    try {
      if (job.protocol === 3) {
        await runArchiveImport(ctx, job, input, meter);
        return null;
      }
      invariant(
        job.protocol === 2,
        'IMPORT_RESTART_REQUIRED',
        `This legacy import cannot resume after the paged-import upgrade. Restart Import from GitHub for ${job.repository} at commit ${job.commit} with a new operation UUID: npx convex run projectGithubImport:start '${JSON.stringify({ url: job.repository, ref: job.commit, operationId: crypto.randomUUID() })}'. The partial project has no published main.`,
      );
      const progress: ImportProgress = JSON.parse(job.cursor);
      invariant(progress.schema === 2, 'IMPORT_CURSOR_CHANGED', 'Import progress format differs.');
      const access = await authorizeImportGithub(job.repository, job.owner, github);
      invariant(
        job.visibility === 'private' || !access.repository.private,
        'GITHUB_VISIBILITY_CHANGED',
        'Repository visibility changed during import; main was not published.',
      );
      // Discovery and blob reads use the App's own quota when it is installed;
      // the importer's credential only re-proves access (one request per page).
      const readToken = async () =>
        (await importReadToken(
          access.repository.full_name,
          (access.repository as { id?: unknown }).id,
          meter.wrap(convexFetch),
        )) ?? access.token;
      const started = Date.now();
      if (!job.totalKnown) {
        const token = await readToken();
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
            token,
            github,
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
            if (
              progress.lfsLimitBytes !== 0 &&
              isGitattributesPath(file.path) &&
              file.size <= lfsAttributeBytes
            ) {
              progress.attributes = [
                ...(progress.attributes ?? []),
                { path: file.path, sha: file.sha, size: file.size },
              ];
              invariant(
                progress.attributes.length <= lfsAttributeFiles,
                'GITHUB_LFS_LIMIT',
                `This repository has more than ${lfsAttributeFiles} .gitattributes files, over this import's Git LFS tracking limit. Main was not published. Retry with a new operation and lfsLimitBytes 0 to keep LFS pointers as committed bytes.`,
              );
            }
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
          githubRequests: meter.counts,
        });
      } else if (job.completed < job.total) {
        const token = await readToken();
        const upload = new ImportUpload(ctx, job.projectId, job.owner);
        const imported: { part: string; key: string; position: number; value: string }[] = [];
        let bytes = job.bytes,
          completed = job.completed;
        const smallPage = entries.every(row => JSON.parse(row.value).size <= objectChunkBytes);
        const blobs = await githubBlobPack(
          job.repository,
          entries
            .map(row => JSON.parse(row.value))
            .filter(file => file.mode !== '160000' && file.size <= objectChunkBytes),
          token,
          github,
        );
        const lfs = progress.lfsLimitBytes === 0 ? null : pagedLfs(progress);
        const held = new Map<string, { at: number; file: GithubSourceEntry }>();
        const sizes: number[] = [];
        for (const row of entries) {
          const file: GithubSourceEntry = JSON.parse(row.value);
          let pin, content: Buffer | undefined;
          if (file.size <= objectChunkBytes) {
            content = file.mode === '160000' ? Buffer.from(file.sha) : blobs.get(file.sha)!;
            pin = { blob: digest(content), size: content.length };
          } else {
            const builder = new ObjectRecipeBuilder(upload.put);
            pin = await streamGithubBlobPack(
              job.repository,
              file,
              async part => {
                for (let offset = 0; offset < part.length; offset += 64 * 1024) {
                  builder.update(part.subarray(offset, offset + 64 * 1024));
                  if (await upload.drain()) await upload.commit();
                }
              },
              token,
              github,
            );
            upload.recipe(pin, builder.finish({ sha256: pin.blob, size: pin.size }).bytes);
          }
          // A pointer-shaped file waits for the page's LFS resolution; its row is filled below.
          const wait =
            content !== undefined && !!lfs && !!parseLfsPointer(content) && lfs.hold(file, content);
          if (content && !wait) upload.put(content);
          if (wait) held.set(file.path, { at: imported.length, file });
          const size = wait ? 0 : file.mode === '160000' ? 0 : pin.size;
          imported.push({
            part: 'imported',
            key: row.key,
            position: completed++,
            value: wait ? '' : JSON.stringify({ path: file.path, ...pin, mode: githubSourceMode(file.mode) }),
          });
          sizes.push(size);
          bytes += size;
          progress.after = row.key;
          // A full byte window stops this page; a large single file streams
          // through multiple bounded physical windows before its logical receipt.
          if (
            bytes - job.bytes >= importPageBytes ||
            (!smallPage && Date.now() - started >= importPageMillis)
          )
            break;
        }
        if (lfs && held.size) {
          const resolved = await resolvePageLfs(ctx, {
            job,
            progress,
            lfs,
            upload,
            held,
            imported,
            sizes,
            token: access.repository.private ? token : undefined,
            github,
            fetchAttributes: entries => githubBlobPack(job.repository, entries, token, github),
            started,
            actor: input.actor,
          });
          completed = job.completed + resolved.rows;
          bytes = job.bytes + resolved.bytes;
        }
        await upload.drain(true);
        await ctx.runMutation(internal.projectGithubImportStore.advance, {
          ...input,
          step: job.step,
          cursor: JSON.stringify(progress),
          completed,
          total: job.total,
          bytes,
          totalBytes: Math.max(job.totalBytes, bytes),
          discovering: false,
          entries: imported,
          ...upload.receipt(),
          githubRequests: meter.counts,
        });
      } else await publishImport(ctx, job, undefined, undefined, meter);
    } catch (error) {
      const known = error instanceof ForgeError;
      await ctx.runMutation(internal.projectGithubImportStore.fail, {
        ...input,
        step: job.step,
        code: known ? error.code : 'GITHUB_IMPORT_INTERRUPTED',
        message: known
          ? error.message
          : 'Import stopped before publication. Retry resumes the same commit and saved page.',
        ...(known && error.retryAt !== undefined ? { retryAt: error.retryAt } : {}),
        githubRequests: meter.counts,
      });
    }
    return null;
  },
});
