// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { internalAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { authorizeGithub } from '../src/github-access';
import { githubConfig } from './access';
import { importReadToken } from './githubAppToken';
import { storeSourceBytes } from './projectSourceBytes';
import { r2Config, r2Key } from './r2';
import { deleteR2Object } from './r2Operations';
import { digest } from '../src/portable-hash';
import { ForgeError, invariant } from '../src/errors';
import { fetchGitPack, PackLimitError } from '../src/git-upload-pack';
import { historyChunkBytes } from './projectHistoryFields';
import { historyLimit } from './projectHistoryStore';
import { githubSyncCommitSchema } from '../src/github-sync-types';

/** Read credential for one github.com repository: the App's own read token when
 * installed, else the importer's authorized one (public: the server read token). */
export async function historyReadToken(repository: string, owner: string, visibility: 'public' | 'private') {
  const access = await authorizeGithub(repository, owner, githubConfig());
  invariant(
    visibility === 'private' || !access.repository.private,
    'GITHUB_VISIBILITY_CHANGED',
    'Repository visibility changed since import; no history was fetched.',
  );
  return (
    (await importReadToken(access.repository.full_name, (access.repository as { id?: unknown }).id)) ??
    access.token ??
    null
  );
}

/** Delay before the single scheduled retry of a failed chunk delete. */
export const historyCleanupRetryMillis = 60_000;

/** Deletes R2 chunks this project's history fetch created but never recorded (over the
 * limit, a failed fetch, a stale or lost record). Chunks a recorded pack pins are kept.
 * Deletes that fail are retried once by a scheduled `cleanup` run. */
export async function discardHistoryChunks(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  sha256s: string[],
  retry = true,
) {
  if (!sha256s.length) return { deleted: 0, kept: 0, failed: 0 };
  const referenced = new Set(
    await ctx.runQuery(internal.projectHistoryStore.referencedChunks, { projectId, sha256s }),
  );
  const config = r2Config(),
    failed: string[] = [];
  let deleted = 0;
  for (const sha256 of new Set(sha256s)) {
    if (referenced.has(sha256)) continue;
    try {
      await deleteR2Object(config, r2Key(projectId, sha256));
      deleted++;
    } catch {
      failed.push(sha256);
    }
  }
  if (failed.length && retry)
    await ctx.scheduler.runAfter(historyCleanupRetryMillis, internal.projectHistoryImport.cleanup, {
      projectId,
      sha256s: failed,
    });
  console.log(
    `FORGE_HISTORY_METRIC ${JSON.stringify({ projectId, phase: retry ? 'discard' : 'discard-retry', deleted, kept: referenced.size, failed: failed.length })}`,
  );
  return { deleted, kept: referenced.size, failed: failed.length };
}

/** The one retry of chunk deletes that failed; a second failure is logged, not rescheduled. */
export const cleanup = internalAction({
  args: { projectId: v.id('hostedProjects'), sha256s: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, input): Promise<null> => {
    await discardHistoryChunks(ctx, input.projectId, input.sha256s, false);
    return null;
  },
});

/** GitHub's pack bytes, unchanged, into content-addressed R2 chunks of at most
 * historyChunkBytes: one chunk buffered at a time, no Convex call per chunk. A failed
 * fetch deletes the chunks it created; `created` lets the caller do the same when the
 * pack is not recorded. */
export async function storeHistoryPack(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  input: { repository: string; want: string; haves: string[]; token: string | null; limitBytes: number },
  chunkBytes = historyChunkBytes,
) {
  const chunks: { sha256: string; size: number }[] = [],
    created: string[] = [];
  let parts: Buffer[] = [],
    buffered = 0;
  const flush = async () => {
    if (!buffered) return;
    const bytes = Buffer.concat(parts, buffered);
    parts = [];
    buffered = 0;
    const pin = { sha256: digest(bytes), size: bytes.length };
    await storeSourceBytes(ctx, projectId, bytes, pin, false, wrote => {
      if (wrote) created.push(pin.sha256);
    });
    chunks.push(pin);
  };
  try {
    const receipt = await fetchGitPack(
      {
        url: `https://github.com/${input.repository}`,
        want: input.want,
        haves: input.haves,
        token: input.token,
        limitBytes: input.limitBytes,
      },
      async part => {
        for (let offset = 0; offset < part.length;) {
          const take = Math.min(part.length - offset, chunkBytes - buffered);
          parts.push(part.subarray(offset, offset + take));
          buffered += take;
          offset += take;
          if (buffered === chunkBytes) await flush();
        }
      },
    );
    await flush();
    return { pack: { chunks, ...receipt }, created };
  } catch (error) {
    await discardHistoryChunks(ctx, projectId, created);
    throw error;
  }
}

/** Records one stored pack; chunks of a pack that was not recorded are deleted. */
export async function recordHistoryPack(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  stored: Awaited<ReturnType<typeof storeHistoryPack>>,
  pack: { tip: string; haves: string[]; source: 'import' | 'catch-up' },
  attempt?: number,
) {
  let recorded: 'recorded' | 'duplicate' | 'stale' | undefined;
  try {
    recorded = await ctx.runMutation(internal.projectHistoryStore.record, {
      projectId,
      ...(attempt === undefined ? {} : { attempt }),
      pack: { ...pack, ...stored.pack },
    });
    return recorded;
  } finally {
    if (recorded !== 'recorded') await discardHistoryChunks(ctx, projectId, stored.created);
  }
}

/** The import's history run: one GitHub fetch, R2 chunk PUTs, one record mutation. */
export const run = internalAction({
  args: { projectId: v.id('hostedProjects'), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, input): Promise<null> => {
    const loaded = await ctx.runQuery(internal.projectHistoryStore.load, { projectId: input.projectId });
    const row = loaded?.row;
    if (!row || row.attempt !== input.attempt || row.status !== 'pending') return null;
    const started = Date.now();
    try {
      const token = await historyReadToken(row.repository, row.owner, row.visibility);
      const stored = await storeHistoryPack(ctx, input.projectId, {
        repository: row.repository,
        want: row.importCommit,
        haves: [],
        token,
        limitBytes: historyLimit(row) - row.bytes,
      });
      await recordHistoryPack(
        ctx,
        input.projectId,
        stored,
        { tip: row.importCommit, haves: [], source: 'import' },
        input.attempt,
      );
      const pack = stored.pack;
      console.log(
        `FORGE_HISTORY_METRIC ${JSON.stringify({ projectId: input.projectId, phase: 'import', bytes: pack.bytes, objects: pack.objects, chunks: pack.chunks.length, elapsedMillis: Date.now() - started })}`,
      );
    } catch (error) {
      const over = error instanceof PackLimitError;
      await ctx.runMutation(internal.projectHistoryStore.finish, {
        projectId: input.projectId,
        attempt: input.attempt,
        status: over ? 'over-limit' : 'failed',
        error: {
          code: error instanceof ForgeError ? error.code : 'HISTORY_IMPORT_FAILED',
          message:
            error instanceof ForgeError
              ? error.message
              : 'The history fetch stopped. The project owner can retry it; the imported tree is unaffected.',
        },
      });
    }
    return null;
  },
});

type Loaded = NonNullable<Awaited<ReturnType<typeof import('./projectHistoryStore').loadHistory>>>;
/** When main's GitHub mirror publishes to the history repository and moved past stored
 * history: at most one coalesced catch-up pack (one reader per mirror move fetches; the
 * others read what is stored). Shared by history reads and Git serving. */
export async function catchUpHistory(ctx: ActionCtx, projectId: Id<'hostedProjects'>, loaded: Loaded) {
  const { row } = loaded;
  let packs = [...loaded.packs],
    addedBytes = 0;
  let main: { commit: string; state: string } | null = null;
  let catchUp: { code: string; message: string } | null = null;
  if (row.status === 'ready' && loaded.mirror?.repository.toLowerCase() === row.repository.toLowerCase()) {
    const mapping = githubSyncCommitSchema.parse(JSON.parse(loaded.mirror.mapping));
    main = { commit: mapping.commit, state: mapping.state };
    if (!packs.some(pack => pack.tip === mapping.commit) && mapping.commit !== row.importCommit) {
      try {
        invariant(
          !loaded.morePacks,
          'HISTORY_PACKS_FULL',
          'This project has too many history packs to add one.',
        );
        invariant(
          await ctx.runMutation(internal.projectHistoryStore.claimCatchUp, {
            projectId,
            tip: mapping.commit,
          }),
          'HISTORY_CATCH_UP_RUNNING',
          'Newer history is being fetched by another read; retry in a minute.',
        );
        const haves = [...new Set(packs.map(pack => pack.tip))];
        const stored = await storeHistoryPack(ctx, projectId, {
          repository: row.repository,
          want: mapping.commit,
          haves,
          token: await historyReadToken(row.repository, row.owner, row.visibility),
          limitBytes: historyLimit(row) - row.bytes,
        });
        const recorded = await recordHistoryPack(ctx, projectId, stored, {
          tip: mapping.commit,
          haves,
          source: 'catch-up',
        });
        if (recorded === 'recorded') {
          packs.push({ tip: mapping.commit, ...stored.pack, at: Date.now() });
          addedBytes = stored.pack.bytes;
        } else if (recorded === 'duplicate') {
          const again = await ctx.runQuery(internal.projectHistoryStore.load, { projectId });
          packs = [...(again?.packs ?? [])];
        }
      } catch (error) {
        // Stored history stays readable; the reply names what is missing.
        catchUp = {
          code:
            error instanceof PackLimitError
              ? 'HISTORY_OVER_LIMIT'
              : error instanceof ForgeError
                ? error.code
                : 'HISTORY_CATCH_UP_FAILED',
          message:
            error instanceof ForgeError
              ? error.message
              : 'Fetching history after the import failed; retry the read.',
        };
      }
    }
  }
  return { packs, addedBytes, main, catchUp };
}

/** Git serving's catch-up step (the HTTP action already checked access). */
export const catchUp = internalAction({
  args: { projectId: v.id('hostedProjects') },
  returns: v.union(v.null(), v.object({ code: v.string(), message: v.string() })),
  handler: async (ctx, { projectId }): Promise<{ code: string; message: string } | null> => {
    const loaded = await ctx.runQuery(internal.projectHistoryStore.load, { projectId });
    if (!loaded) return null;
    return (await catchUpHistory(ctx, projectId, loaded)).catchUp;
  },
});
