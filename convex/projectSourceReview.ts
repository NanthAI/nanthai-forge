// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { action, type ActionCtx } from './cliServer';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { exchangeObjectReader } from './projectExchangeReader';
import { exchangeRootSchema, isExchangeRoot, readByteTree } from '../src/native-exchange-tree';
import { nativeManifestSchema } from '../src/work-archive-metadata';
import { indexedReviewBytes, ReviewIndexUnavailable } from './projectSourceReviewIndex';
import { readNativeSourceReview, readNativeSourceReviewBytes } from '../src/native-source-review';
import { digest } from '../src/hash';
import { invariant } from '../src/errors';
import type { SourceAnchor } from '../src/work-intent-types';
import { report } from './errors';

async function checkpoint(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  backupId: Id<'projectBackups'>,
  actor: string,
) {
  const value: { backup: Doc<'projectBackups'>; project: Doc<'hostedProjects'> } = await ctx.runQuery(
    internal.projectBackups.get,
    { id: backupId, owner: actor },
  );
  invariant(
    value.project._id === projectId &&
      value.backup.projectId === projectId &&
      value.backup.status === 'stored',
    'PROJECT_UNAVAILABLE',
    'Select a stored checkpoint from this project.',
  );
  return value.backup;
}
type ReviewInput = {
  projectId: Id<'hostedProjects'>;
  backupId: Id<'projectBackups'>;
  base: string;
  head: string;
  file?: string;
  map?: boolean;
  beforeOffset?: number;
  afterOffset?: number;
  line?: number;
  anchor?: SourceAnchor;
};
export async function readSourceReview(ctx: ActionCtx, input: ReviewInput, actor: string) {
  const started = performance.now();
  const backup = await checkpoint(ctx, input.projectId, input.backupId, actor);
  if (backup.transport !== 'objects' || backup.preview.format !== 'native') {
    invariant(
      !input.anchor,
      'SOURCE_UNAVAILABLE',
      'Choose a retained native source View for this line comment.',
    );
    return {
      available: false,
      reason:
        'This checkpoint uses a source archive. Its existing download contains source and Work for local review.',
    };
  }
  const indexed = await indexedReviewBytes(ctx, backup, actor);
  if (indexed) {
    try {
      const result = await readNativeSourceReviewBytes(input.base, input.head, indexed, {
        file: input.file,
        map: input.map,
        beforeOffset: input.beforeOffset,
        afterOffset: input.afterOffset,
        line: input.line,
        anchor: input.anchor,
      });
      const final = await checkpoint(ctx, input.projectId, input.backupId, actor);
      invariant(
        final.digest === backup.digest && final.preview.manifestDigest === backup.preview.manifestDigest,
        'SOURCE_CHANGED',
        'The selected checkpoint changed while reading.',
      );
      return {
        available: true,
        backupId: backup._id,
        backupDigest: backup.digest,
        ...result,
        timings: { manifestMs: 0, totalMs: performance.now() - started },
      };
    } catch (error) {
      if (!(error instanceof ReviewIndexUnavailable)) throw error;
      // The original immutable backup/head selection remains unchanged on a derived-index miss.
    }
  }
  const reader = exchangeObjectReader(ctx, true),
    read = (pins: { sha256: string; size: number }[]) => reader.read(input.projectId, actor, pins);
  const [root] = await read([
    {
      sha256: backup.objectManifest?.digest ?? backup.digest,
      size: backup.objectManifest?.size ?? backup.size,
    },
  ]);
  invariant(root, 'INVALID_WORK_BACKUP', 'Source manifest is unavailable.');
  const value: unknown = JSON.parse(root.toString('utf8'));
  // Review needs the source manifest only; it does not load or replay all retained Work.
  const manifestBytes = isExchangeRoot(value)
    ? await readByteTree(exchangeRootSchema.parse(value).manifest, read)
    : root;
  invariant(
    digest(manifestBytes) === backup.preview.manifestDigest,
    'INVALID_WORK_BACKUP',
    'Source manifest differs from this checkpoint.',
  );
  const manifest = nativeManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
  invariant(
    manifest.head === backup.preview.head,
    'INVALID_WORK_BACKUP',
    'Source checkpoint identity differs.',
  );
  const manifestMs = performance.now() - started;
  const result = await readNativeSourceReview(
    manifest,
    input.base,
    input.head,
    read,
    input.file === undefined && !input.map
      ? undefined
      : {
          ...(input.file === undefined ? {} : { file: input.file }),
          ...(input.map ? { map: true } : {}),
          beforeOffset: input.beforeOffset,
          afterOffset: input.afterOffset,
          line: input.line,
          anchor: input.anchor,
        },
  );
  const final = await checkpoint(ctx, input.projectId, input.backupId, actor);
  invariant(
    final.digest === backup.digest && final.preview.manifestDigest === backup.preview.manifestDigest,
    'SOURCE_CHANGED',
    'The selected checkpoint changed while reading.',
  );
  return {
    available: true,
    backupId: backup._id,
    backupDigest: backup.digest,
    ...result,
    timings: { manifestMs, totalMs: performance.now() - started },
  };
}
export const read = action({
  args: {
    projectId: v.id('hostedProjects'),
    backupId: v.id('projectBackups'),
    base: v.string(),
    head: v.string(),
    file: v.optional(v.string()),
    map: v.optional(v.boolean()),
    beforeOffset: v.optional(v.number()),
    afterOffset: v.optional(v.number()),
    line: v.optional(v.number()),
  },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to review project source.');
      return JSON.stringify(await readSourceReview(ctx, input, user.subject));
    } catch (error) {
      return report(error);
    }
  },
});
