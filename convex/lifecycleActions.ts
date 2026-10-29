// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { action } from './cliServer';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { currentAccess } from './access';
import { invariant } from '../src/errors';
import { archiveDownload, directDownloadFields } from './archiveDownload';
import { projectArchivePart } from './projectArchivePart';
import { report } from './errors';

export const restore = action({
  args: { id: v.id('imports') },
  returns: v.null(),
  handler: async (ctx, { id }): Promise<null> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      const { job } = await currentAccess(ctx, id, user?.subject, true);
      invariant(
        user && job.visibility === 'private' && job.owner === user.subject,
        'GITHUB_UNAVAILABLE',
        'This Codescape is unavailable with the current access.',
      );
      return await ctx.runMutation(internal.lifecycle.restore, { id, owner: user.subject });
    } catch (error) {
      return report(error);
    }
  },
});

export const snapshotInfo = action({
  args: { id: v.id('imports') },
  returns: v.object({
    bytes: v.number(),
    digest: v.string(),
    contentType: v.string(),
    head: v.string(),
    generation: v.number(),
  }),
  handler: async (
    ctx,
    { id },
  ): Promise<{ bytes: number; digest: string; contentType: string; head: string; generation: number }> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      const { job } = await currentAccess(ctx, id, user?.subject, false, true);
      invariant(
        user && job.visibility === 'private' && job.owner === user.subject,
        'GITHUB_UNAVAILABLE',
        'This Codescape is unavailable with the current access.',
      );
      invariant(job.artifactKey && job.head, 'INDEX_MISSING', 'This repository has no indexed snapshot yet.');
      const file: { size: number; sha256: string; contentType?: string } | null = await ctx.runQuery(
        internal.lifecycle.fileInfo,
        { id: job.artifactKey as Id<'_storage'> },
      );
      invariant(file, 'INVALID_ARTIFACT', 'Stored source is unavailable.');
      await currentAccess(ctx, id, user.subject, false, true);
      const current: Doc<'imports'> | null = await ctx.runQuery(internal.imports.get, { id });
      invariant(
        current &&
          !current.removal &&
          current.visibility === 'private' &&
          current.owner === user.subject &&
          current.artifactKey === job.artifactKey &&
          current.head === job.head &&
          current.generation === job.generation,
        'STATE_MISMATCH',
        'The indexed snapshot changed during inspection. Inspect its current metadata again.',
      );
      return {
        bytes: file.size,
        digest: file.sha256,
        contentType: file.contentType ?? 'unknown',
        head: job.head,
        generation: job.generation,
      };
    } catch (error) {
      return report(error);
    }
  },
});

export const downloadPart = action({
  args: { id: v.id('imports'), offset: v.number(), digest: v.optional(v.string()) },
  returns: v.object({
    ...directDownloadFields,
    data: v.bytes(),
    size: v.number(),
    digest: v.string(),
    contentType: v.string(),
    repository: v.string(),
    head: v.string(),
  }),
  handler: async (
    ctx,
    { id, offset, digest },
  ): Promise<{
    direct?: boolean;
    url?: string;
    data: ArrayBuffer;
    size: number;
    digest: string;
    contentType: string;
    repository: string;
    head: string;
  }> => {
    try {
      invariant(Number.isSafeInteger(offset) && offset >= 0, 'BAD_ARGUMENT', 'Invalid download offset.');
      const user = await ctx.auth.getUserIdentity();
      const { job } = await currentAccess(ctx, id, user?.subject);
      invariant(job.artifactKey && job.head, 'INDEX_MISSING', 'This repository has no indexed snapshot yet.');
      const file: { size: number; sha256: string; contentType?: string } | null = await ctx.runQuery(
        internal.lifecycle.fileInfo,
        { id: job.artifactKey as Id<'_storage'> },
      );
      invariant(file, 'INVALID_ARTIFACT', 'Stored source is unavailable.');
      invariant(
        !digest || digest === file.sha256,
        'STATE_MISMATCH',
        'The indexed snapshot changed during download. Download again to get one complete revision.',
      );
      invariant(
        offset < file.size || (offset === 0 && file.size === 0),
        'BAD_ARGUMENT',
        'Download offset exceeds the snapshot.',
      );
      const key = job.artifactKey as Id<'_storage'>;
      const normalized = /^[0-9a-f]{64}$/.test(file.sha256)
        ? file.sha256
        : Buffer.from(file.sha256, 'base64').toString('hex');
      let contentType = file.contentType ?? '';
      const direct = await archiveDownload(ctx, { storageId: key, size: file.size, digest: normalized });
      const data = direct
        ? direct.data
        : await projectArchivePart(
            ctx,
            key,
            file.size,
            normalized,
            offset,
            () => currentAccess(ctx, id, user?.subject),
            'INVALID_ARTIFACT',
            value => {
              contentType = file.contentType ?? value;
            },
          );
      await currentAccess(ctx, id, user?.subject);
      return {
        ...direct,
        data,
        size: file.size,
        digest: file.sha256,
        contentType,
        repository: job.repository,
        head: job.head,
      };
    } catch (error) {
      return report(error);
    }
  },
});
