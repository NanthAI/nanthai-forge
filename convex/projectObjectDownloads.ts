// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation, type MutationCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { blobStore } from './blobStore';
import { storageDigest } from './projectStorage';
import { isStored } from './projectObjectFields';
import type { DownloadRow } from '../src/blob-download-format';
import { selectedGeneration, record, recordPartition } from './projectWorkIndexStore';
import { workProject } from './projectWorkHead';
import { accessibleProject } from './projectAuthority';
import { isR2Object } from './projectObjectFields';
import { r2Config, r2Key, presignGet } from './r2';
import { invariant } from '../src/errors';
import { report } from './errors';

async function readableProject(ctx: MutationCtx, projectId: Id<'hostedProjects'>) {
  const user = await ctx.auth.getUserIdentity();
  if (user) return accessibleProject(ctx, projectId, user.subject);
  const project = await ctx.db.get(projectId);
  invariant(
    project && project.visibility === 'public' && !project.removal,
    'PROJECT_UNAVAILABLE',
    'This Forge project is unavailable with the current account.',
  );
  return project;
}

/** The single choke point for reading R2 bytes: a signed GET (5 minutes) for each requested digest
 * that is a committed R2 object of this project, after a fresh access check on every call. Anything
 * else (unknown, pending, another project's, or stored in Convex) is simply absent from the result,
 * so the caller learns nothing beyond what it can already list. A mutation so that results are never
 * cached across calls and a URL is always freshly signed. It writes nothing. Public projects sign
 * without sign-in. Committed rows stay readable when `FORGE_BLOBS` is unset, while the R2 settings
 * are configured; without them this fails closed.
 * TODO(owner): anonymous signing for public projects has no budget counter yet (docs/r2-storage-plan.md). */
export const signDownloads = mutation({
  args: { projectId: v.id('hostedProjects'), digests: v.array(v.string()) },
  returns: v.array(v.object({ digest: v.string(), size: v.number(), url: v.string() })),
  handler: async (ctx, { projectId, digests }) => {
    try {
      invariant(digests.length <= 100, 'BAD_ARGUMENT', 'Sign downloads in pages of at most 100.');
      await readableProject(ctx, projectId);
      const found = [];
      for (const digest of new Set(digests)) {
        if (!/^[0-9a-f]{64}$/.test(digest)) continue;
        const row = await ctx.db
          .query('projectObjects')
          .withIndex('by_project_and_digest', q => q.eq('projectId', projectId).eq('digest', digest))
          .unique();
        if (row && !row.removed && isR2Object(row) && row.r2Key === r2Key(projectId, digest))
          found.push({ digest, size: row.size, key: row.r2Key });
      }
      if (!found.length) return [];
      const config = r2Config();
      return await Promise.all(
        found.map(async ({ digest, size, key }) => ({ digest, size, url: await presignGet(config, key) })),
      );
    } catch (error) {
      return report(error);
    }
  },
});

/** Location metadata only: an R2 response never proxies object bytes through Convex. */
export const describe = mutation({
  args: { projectId: v.id('hostedProjects'), digests: v.array(v.string()) },
  returns: v.array(
    v.union(
      v.object({ digest: v.string(), size: v.number(), location: v.literal('r2') }),
      v.object({ digest: v.string(), size: v.number(), location: v.literal('convex'), url: v.string() }),
      v.object({
        digest: v.string(),
        size: v.number(),
        location: v.literal('recipe'),
        recipe: v.object({ digest: v.string(), size: v.number() }),
      }),
    ),
  ),
  handler: async (ctx, { projectId, digests }) => {
    try {
      await readableProject(ctx, projectId);
      invariant(
        digests.length <= 100 && digests.every(id => /^[a-f0-9]{64}$/.test(id)),
        'BAD_ARGUMENT',
        'Read exact content identities in pages of at most 100.',
      );
      const result: DownloadRow[] = [];
      for (const digest of digests) {
        const row = await ctx.db
          .query('projectObjects')
          .withIndex('by_project_and_digest', q => q.eq('projectId', projectId).eq('digest', digest))
          .unique();
        invariant(
          row && isStored(row) && !row.removed,
          'INVALID_WORK_BACKUP',
          'Stored content is unavailable.',
        );
        const pin = { digest, size: row.size };
        if (isR2Object(row)) {
          invariant(
            row.r2Key === r2Key(projectId, digest),
            'INVALID_WORK_BACKUP',
            'Stored content has a different project binding.',
          );
          result.push({ ...pin, location: 'r2' });
        } else if (row.storageId) {
          const metadata = await blobStore(ctx).getMetadata(row.storageId),
            url = await blobStore(ctx).getUrl(row.storageId);
          invariant(
            metadata && metadata.size === row.size && storageDigest(metadata.sha256) === digest && url,
            'INVALID_WORK_BACKUP',
            'Stored content differs from its original binding.',
          );
          result.push({ ...pin, location: 'convex', url });
        } else {
          invariant(row.recipe, 'INVALID_WORK_BACKUP', 'Stored content representation is unavailable.');
          result.push({ ...pin, location: 'recipe', recipe: row.recipe });
        }
      }
      return result;
    } catch (error) {
      return report(error);
    }
  },
});

/** Exact checkpoint and optional disposable source pins; never reads source/file bytes. */
export const source = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    backupId: v.id('projectBackups'),
    digests: v.optional(v.array(v.string())),
  },
  returns: v.string(),
  handler: async (ctx, { projectId, backupId, digests = [] }) => {
    try {
      const project = await readableProject(ctx, projectId),
        backup = await ctx.db.get(backupId);
      invariant(
        backup && backup.projectId === projectId && backup.status === 'stored',
        'PROJECT_UNAVAILABLE',
        'Select a stored checkpoint from this project.',
      );
      invariant(
        digests.length <= 100 && digests.every(id => /^[a-f0-9]{64}$/.test(id)),
        'BAD_ARGUMENT',
        'Read exact source identities in pages of at most 100.',
      );
      const generation = await selectedGeneration(ctx, await workProject(ctx, project));
      const pins =
        generation?.backupId === backupId
          ? await Promise.all(
              digests.map(async id => {
                const row = await record(ctx, recordPartition(generation), 'sourceBlobs', id);
                if (!row) return null;
                try {
                  const pin = JSON.parse(row.value) as { sha256: string; size: number };
                  return pin.sha256 === id && Number.isSafeInteger(pin.size) && pin.size >= 0 ? pin : null;
                } catch {
                  return null;
                }
              }),
            )
          : null;
      return JSON.stringify({
        backupId,
        backupDigest: backup.digest,
        manifestDigest: backup.preview.manifestDigest,
        format: backup.preview.format,
        operationId: backup.operationId,
        transport: backup.transport ?? 'archive',
        root: {
          sha256: backup.objectManifest?.digest ?? backup.digest,
          size: backup.objectManifest?.size ?? backup.size,
        },
        pins: pins?.every(Boolean) ? pins : null,
      });
    } catch (error) {
      return report(error);
    }
  },
});
