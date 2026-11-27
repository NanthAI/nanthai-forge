// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
'use node';
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { action, type ActionCtx } from './cliServer';
import { internal, api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { exchangeObjectReader } from './projectExchangeReader';
import { exchangeRootSchema, isExchangeRoot, readByteTree } from '../src/native-exchange-tree';
import { nativeManifestSchema } from '../src/work-archive-metadata';
import { indexedReviewBytes, ReviewIndexUnavailable } from './projectSourceReviewIndex';
import { nativeReviewBytes, readNativeSourceReviewBytes } from '../src/native-source-review';
import { digest } from '../src/hash';
import { invariant } from '../src/errors';
import { backupManifestDigest, backupRootPin } from '../src/work-backup-root';
import type { SourceAnchor } from '../src/work-intent-types';
import { report } from './errors';
import { takeVisitorRead } from './visitorBudget';

async function checkpoint(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  backupId: Id<'projectBackups'>,
  actor: string,
  view?: { recheck: boolean; digests: string[] },
): Promise<Doc<'projectBackups'> & { viewPins?: { sha256: string; size: number }[] | null }> {
  if (view) {
    const client = actor ? undefined : takeVisitorRead(ctx);
    const result: { backup: Doc<'projectBackups'>; pins: { sha256: string; size: number }[] | null } =
      await ctx.runMutation(makeFunctionReference<'mutation'>('projectSourceReviewStore:checkpoint'), {
        projectId,
        backupId,
        ...view,
        ...(client ? { client } : {}),
      });
    return { ...result.backup, viewPins: result.pins };
  }
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
  submodules?: boolean;
  beforeOffset?: number;
  afterOffset?: number;
  line?: number;
  anchor?: SourceAnchor;
};
export async function readSourceReview(ctx: ActionCtx, input: ReviewInput, actor: string, viewOnly = false) {
  return renderCheckpointSource(ctx, input, actor, viewOnly, bytes =>
    readNativeSourceReviewBytes(input.base, input.head, bytes, input),
  );
}

/** Render with the same retained membership, object integrity and final access checks as a review. */
export async function renderCheckpointSource<T extends object>(
  ctx: ActionCtx,
  input: Pick<ReviewInput, 'projectId' | 'backupId' | 'base' | 'head' | 'anchor'>,
  actor: string,
  viewOnly: boolean,
  render: (bytes: (ids: string[], maximumObjectBytes?: number) => Promise<Buffer[]>) => Promise<T>,
) {
  const started = performance.now();
  const backup = await checkpoint(
    ctx,
    input.projectId,
    input.backupId,
    actor,
    viewOnly ? { recheck: false, digests: [...new Set([input.base, input.head])] } : undefined,
  );
  if (backup.transport !== 'objects' || backup.preview.format !== 'native') {
    invariant(
      !input.anchor,
      'SOURCE_UNAVAILABLE',
      'Choose a retained native source View for this line comment.',
    );
    return {
      available: false as const,
      reason:
        'This checkpoint uses a source archive. Its existing download contains source and Work for local review.',
    };
  }
  const indexed = await indexedReviewBytes(ctx, backup, actor, backup.viewPins);
  if (indexed) {
    try {
      const result = await render(indexed);
      const final = await checkpoint(
        ctx,
        input.projectId,
        input.backupId,
        actor,
        viewOnly ? { recheck: true, digests: [] } : undefined,
      );
      invariant(
        final.digest === backup.digest && final.preview.manifestDigest === backup.preview.manifestDigest,
        'SOURCE_CHANGED',
        'The selected checkpoint changed while reading.',
      );
      return {
        available: true as const,
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
  const [root] = await read([backupRootPin(backup)]);
  invariant(root, 'INVALID_WORK_BACKUP', 'Source manifest is unavailable.');
  const value: unknown = JSON.parse(root.toString('utf8'));
  // Review needs the source manifest only; it does not load or replay all retained Work.
  const manifestBytes = isExchangeRoot(value)
    ? await readByteTree(exchangeRootSchema.parse(value).manifest, read)
    : root;
  invariant(
    digest(manifestBytes) === backupManifestDigest(backup),
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
  const result = await render(nativeReviewBytes(manifest, read));
  const final = await checkpoint(
    ctx,
    input.projectId,
    input.backupId,
    actor,
    viewOnly ? { recheck: true, digests: [] } : undefined,
  );
  invariant(
    final.digest === backup.digest && final.preview.manifestDigest === backup.preview.manifestDigest,
    'SOURCE_CHANGED',
    'The selected checkpoint changed while reading.',
  );
  return {
    available: true as const,
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
    submodules: v.optional(v.boolean()),
    render: v.optional(v.boolean()),
    beforeOffset: v.optional(v.number()),
    afterOffset: v.optional(v.number()),
    line: v.optional(v.number()),
  },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    try {
      if (input.render) {
        invariant(
          [input.base, input.head].every(id => /^[a-f0-9]{64}$/.test(id)),
          'BAD_ARGUMENT',
          'Select exact source State identities.',
        );
        const user = await ctx.auth.getUserIdentity();
        // Signed-out visitors read through the site's cached public route, which carries their visitor limit.
        invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read this comparison.');
        return JSON.stringify(await readSourceReview(ctx, input, user.subject, true));
      }
      // Signed-in browser callers receive a checkpoint plan. They verify objects directly,
      // including Convex rows; server-only anchor validation still uses readSourceReview above.
      return await ctx.runMutation(api.projectObjectDownloads.source, {
        projectId: input.projectId,
        backupId: input.backupId,
        digests: [input.base, input.head],
      });
    } catch (error) {
      return report(error);
    }
  },
});
