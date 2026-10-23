// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { blobStore } from './blobStore';
import { storeProjectArtifact } from './projectArtifactActions';
import { internalAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { authorizeGithub } from '../src/github-access';
import { githubConfig } from './access';
import {
  discoverGithubSource,
  importGithubSourceFile,
  type GithubSourceCursor,
} from '../src/github-project-source';
import { githubHostedProject, type GithubHostedFile } from '../src/hosted-github-bootstrap';
import { buildObjectRecipe, objectChunkBytes } from '../src/object-chunks';
import { digest } from '../src/hash';
import { ForgeError, invariant } from '../src/errors';
type Cursor = { source: GithubSourceCursor; files: GithubHostedFile[] };

/** Bytes never cross an action/mutation argument boundary. Each stored physical
 * part has its own verified digest and at most the existing object chunk size. */
async function put(
  ctx: ActionCtx,
  job: Doc<'projectGithubImports'>,
  bytes: Buffer,
  chunk = true,
): Promise<void> {
  const pin = { projectId: job.projectId, actor: job.owner, digest: digest(bytes), size: bytes.length };
  if (await ctx.runMutation(internal.projectGithubImportObjects.reuse, pin)) return;
  if (chunk && bytes.length > objectChunkBytes) {
    const representation = buildObjectRecipe(bytes);
    for (const content of representation.objects.values()) await put(ctx, job, content, false);
    await put(ctx, job, representation.bytes, false);
    await ctx.runMutation(internal.projectObjectRecipeStore.bind, {
      ...pin,
      recipeDigest: digest(representation.bytes),
      recipeSize: representation.bytes.length,
    });
    return;
  }
  await storeProjectArtifact(ctx, job.projectId, job.owner, bytes);
}
export const run = internalAction({
  args: { id: v.id('projectGithubImports'), actor: v.string() },
  returns: v.null(),
  handler: async (ctx, input): Promise<null> => {
    const job: Doc<'projectGithubImports'> = await ctx.runQuery(internal.projectGithubImportStore.get, input);
    if (job.phase === 'ready') return null;
    try {
      // Fresh provider access on every action; no token is written to cursor/DB.
      const access = await authorizeGithub(job.repository, job.owner, githubConfig());
      invariant(
        job.visibility === 'private' || !access.repository.private,
        'GITHUB_VISIBILITY_CHANGED',
        'Repository visibility changed during import; main was not published.',
      );
      const blob = await blobStore(ctx).get(job.cursor);
      invariant(blob, 'IMPORT_CURSOR_UNAVAILABLE', 'The original import cursor is unavailable.');
      const cursor: Cursor = JSON.parse(await blob.text());
      invariant(
        cursor.source.commit === job.commit &&
          cursor.source.repository === job.repository &&
          cursor.source.completed === job.completed,
        'IMPORT_CURSOR_CHANGED',
        'Import cursor differs from its pinned commit and progress.',
      );
      if (cursor.source.pending.length)
        cursor.source = await discoverGithubSource(cursor.source, access.token);
      else if (cursor.source.completed < cursor.source.files.length) {
        const next = await importGithubSourceFile(cursor.source, bytes => put(ctx, job, bytes), access.token);
        cursor.source = next.cursor;
        cursor.files.push({
          ...next.file,
          mode: { '100644': 'file' as const, '100755': 'executable' as const, '120000': 'symlink' as const }[
            next.file.mode
          ],
        });
      } else {
        const bootstrap = githubHostedProject(job.operationId, job.at, job.commit, cursor.files);
        for (const object of bootstrap.objects) await put(ctx, job, Buffer.from(object.text));
        // Recheck GitHub immediately before publishing retained main.
        const current = await authorizeGithub(job.repository, job.owner, githubConfig());
        invariant(
          job.visibility === 'private' || !current.repository.private,
          'GITHUB_VISIBILITY_CHANGED',
          'Repository visibility changed during import; main was not published.',
        );
        await ctx.runMutation(internal.projectGithubImportStore.publish, {
          ...input,
          step: job.step,
          files: cursor.files,
        });
        return null;
      }
      const placement = await ctx.runQuery(internal.projectGithubImportObjects.placement, {
        projectId: job.projectId,
        actor: job.owner,
      });
      const storageId = await blobStore(ctx).store(
        new Blob([JSON.stringify(cursor)], { type: 'application/json' }),
        placement ? { r2Namespace: `v1/p/${job.projectId}/import/${job._id}/${job.step + 1}` } : undefined,
      );
      await ctx.runMutation(internal.projectGithubImportStore.advance, {
        ...input,
        step: job.step,
        cursor: storageId,
        completed: cursor.source.completed,
        total: cursor.source.files.length,
        bytes: cursor.source.bytes,
        totalBytes: cursor.source.totalBytes,
        discovering: cursor.source.pending.length > 0,
      });
    } catch (error) {
      const known = error instanceof ForgeError;
      await ctx.runMutation(internal.projectGithubImportStore.fail, {
        ...input,
        step: job.step,
        code: known ? error.code : 'GITHUB_IMPORT_INTERRUPTED',
        message: known
          ? error.message
          : 'Import stopped before publication. Retry resumes the same commit and saved progress.',
      });
    }
    return null;
  },
});
