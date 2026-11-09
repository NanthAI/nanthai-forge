// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation, type MutationCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { blobStore } from './blobStore';
import { storageDigest } from './projectStorage';
import { isStored } from './projectObjectFields';
import type { DownloadRow } from '../src/blob-download-format';
import { selectedGeneration, readRecord, recordPartition } from './projectWorkIndexStore';
import { workProject } from './projectWorkHead';
import { accessibleProject } from './projectAuthority';
import { isR2Object } from './projectObjectFields';
import { r2Config, r2Key, presignGet } from './r2';
import { invariant } from '../src/errors';
import { report } from './errors';
import { hostedDownloadPageSize, type HostedDownloadDescriptor } from '../src/hosted-download-page';
import { findObject, findObjects } from './projectObjectFind';
import { chargeAnonymousRead } from './abuseLimits';
import { packRange, packHeaders, type ObjectPack } from '../src/object-pack-range';
import { runValue, signRuns, type RunBinding } from './projectObjectRuns';
const rangeValue = v.optional(v.object({ offset: v.number(), total: v.number() }));
export async function readableProject(ctx: MutationCtx, projectId: Id<'hostedProjects'>) {
  const user = await ctx.auth.getUserIdentity();
  if (user) return accessibleProject(ctx, projectId, user.subject);
  const project = await ctx.db.get(projectId);
  invariant(
    project && project.visibility === 'public' && !project.removal,
    'PROJECT_UNAVAILABLE',
    'This Forge project is unavailable with the current account.',
  );
  await chargeAnonymousRead(ctx, projectId);
  return project;
}

/** General exchange signing: a signed GET (5 minutes) for each requested digest
 * that is a committed R2 object of this project, after a fresh access check on every call. Anything
 * else (unknown, pending, another project's, or stored in Convex) is simply absent from the result,
 * so the caller learns nothing beyond what it can already list. A mutation so that results are never
 * cached across calls and a URL is always freshly signed. It writes nothing. Public projects sign
 * without sign-in, within the signed-out budget in convex/abuseLimits.ts. Without the R2 settings
 * this fails closed. */
export const signDownloads = mutation({
  args: { projectId: v.id('hostedProjects'), digests: v.array(v.string()) },
  returns: v.array(v.object({ digest: v.string(), size: v.number(), url: v.string(), range: rangeValue })),
  handler: async (ctx, { projectId, digests }) => {
    try {
      invariant(digests.length <= 100, 'BAD_ARGUMENT', 'Sign downloads in pages of at most 100.');
      await readableProject(ctx, projectId);
      const found = [];
      for (const digest of new Set(digests)) {
        if (!/^[0-9a-f]{64}$/.test(digest)) continue;
        const row = await findObject(ctx, projectId, digest);
        if (
          row &&
          !row.removed &&
          isR2Object(row) &&
          row.r2Key === r2Key(projectId, row.pack?.digest ?? digest)
        )
          found.push({
            digest,
            size: row.size,
            key: row.r2Key,
            ...(row.pack ? { range: packRange(row)! } : {}),
          });
      }
      if (!found.length) return [];
      const config = r2Config();
      return await Promise.all(
        found.map(async ({ digest, size, key, ...binding }) => ({
          digest,
          size,
          url: await presignGet(config, key, packHeaders(binding.range, size)),
          ...binding,
        })),
      );
    } catch (error) {
      return report(error);
    }
  },
});

/** Location metadata only: an R2 response never proxies object bytes through Convex.
 * Checkout clients request signatures in the same bounded page, avoiding a second
 * membership/binding lookup per object. Signing writes no documents. */
export const describe = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    digests: v.array(v.string()),
    signed: v.optional(v.boolean()),
    /** Signed pages of up to hostedDownloadPageSize; neighbours in one stored pack share a run. */
    runs: v.optional(v.boolean()),
  },
  returns: v.array(
    v.union(
      v.object({
        digest: v.string(),
        size: v.number(),
        location: v.literal('r2'),
        url: v.optional(v.string()),
        range: rangeValue,
        run: runValue,
      }),
      v.object({ digest: v.string(), size: v.number(), location: v.literal('convex'), url: v.string() }),
      v.object({
        digest: v.string(),
        size: v.number(),
        location: v.literal('recipe'),
        /** Signed calls also sign the recipe object itself, so reading it needs no second call. */
        recipe: v.object({
          digest: v.string(),
          size: v.number(),
          url: v.optional(v.string()),
          range: rangeValue,
        }),
      }),
    ),
  ),
  handler: async (ctx, { projectId, digests, signed, runs }) => {
    try {
      await readableProject(ctx, projectId);
      invariant(
        digests.length <= (runs ? hostedDownloadPageSize : 100) &&
          digests.every(id => /^[a-f0-9]{64}$/.test(id)) &&
          (!runs || signed),
        'BAD_ARGUMENT',
        'Read exact content identities in pages of at most 100 (signed runs: 500).',
      );
      const result: (DownloadRow & { url?: string; run?: RunBinding })[] = [];
      const packed: { index: number; size: number; pack: ObjectPack; key: string }[] = [],
        seen = new Set<string>();
      const rows = await findObjects(ctx, projectId, digests);
      for (const [i, digest] of digests.entries()) {
        const row = rows[i];
        invariant(
          row && isStored(row) && !row.removed,
          'INVALID_WORK_BACKUP',
          'Stored content is unavailable.',
        );
        const pin = { digest, size: row.size };
        if (isR2Object(row)) {
          invariant(
            row.r2Key === r2Key(projectId, row.pack?.digest ?? digest),
            'INVALID_WORK_BACKUP',
            'Stored content has a different project binding.',
          );
          // Packed rows are signed after the page is read (runs); every other row as before.
          const deferred = runs === true && !!row.pack && row.size > 0 && !seen.has(digest);
          seen.add(digest);
          if (deferred)
            packed.push({ index: result.length, size: row.size, pack: row.pack!, key: row.r2Key });
          result.push({
            ...pin,
            location: 'r2',
            ...(row.pack ? { range: packRange(row)! } : {}),
            ...(signed && !deferred
              ? { url: await presignGet(r2Config(), row.r2Key, packHeaders(packRange(row), row.size)) }
              : {}),
          });
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
          const node = signed ? await findObject(ctx, projectId, row.recipe.digest) : null;
          const signable =
            node &&
            !node.removed &&
            isR2Object(node) &&
            node.size === row.recipe.size &&
            node.r2Key === r2Key(projectId, node.pack?.digest ?? row.recipe.digest);
          result.push({
            ...pin,
            location: 'recipe',
            recipe: signable
              ? {
                  ...row.recipe,
                  url: await presignGet(r2Config(), node.r2Key!, packHeaders(packRange(node), node.size)),
                  ...(node.pack ? { range: packRange(node)! } : {}),
                }
              : { digest: row.recipe.digest, size: row.recipe.size },
          });
        }
      }
      if (runs) await signRuns(result, packed);
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
                const row = await readRecord(ctx, recordPartition(generation), 'sourceBlobs', id);
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

/** Lane size discovery and R2 signatures share one transaction. Legacy objects
 * retain their existing byte path; never inspect their Convex storage metadata here.
 * The unsigned call rechecks the same bindings after client IO without re-signing. */
export const lanePage = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    digests: v.array(v.string()),
    signed: v.boolean(),
    /** Neighbours in one stored pack share one signed run (see describe). */
    runs: v.optional(v.boolean()),
  },
  returns: v.array(
    v.object({
      digest: v.string(),
      size: v.number(),
      url: v.optional(v.string()),
      range: rangeValue,
      run: runValue,
    }),
  ),
  handler: async (ctx, { projectId, digests, signed, runs }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read hosted source.');
      await accessibleProject(ctx, projectId, user.subject);
      invariant(
        digests.length <= hostedDownloadPageSize && digests.every(id => /^[a-f0-9]{64}$/.test(id)),
        'BAD_ARGUMENT',
        'Read exact content identities in bounded pages.',
      );
      const result: (HostedDownloadDescriptor & { run?: RunBinding })[] = [];
      const packed: { index: number; size: number; pack: ObjectPack; key: string }[] = [],
        seen = new Set<string>();
      const rows = await findObjects(ctx, projectId, digests);
      for (const [i, digest] of digests.entries()) {
        const row = rows[i];
        invariant(
          row && !row.removed && isStored(row),
          'SOURCE_UNAVAILABLE',
          'Requested project source object is unavailable.',
        );
        const deferred =
          runs === true && signed && isR2Object(row) && !!row.pack && row.size > 0 && !seen.has(digest);
        seen.add(digest);
        if (deferred) packed.push({ index: result.length, size: row.size, pack: row.pack!, key: row.r2Key! });
        if (isR2Object(row)) {
          invariant(
            row.r2Key === r2Key(projectId, row.pack?.digest ?? digest),
            'INVALID_WORK_BACKUP',
            'Stored content has a different project binding.',
          );
        }
        result.push({
          digest,
          size: row.size,
          ...(row.pack ? { range: packRange(row)! } : {}),
          ...(signed && isR2Object(row) && !deferred
            ? { url: await presignGet(r2Config(), row.r2Key!, packHeaders(packRange(row), row.size)) }
            : {}),
        });
      }
      if (packed.length) await signRuns(result, packed);
      return result;
    } catch (error) {
      return report(error);
    }
  },
});
