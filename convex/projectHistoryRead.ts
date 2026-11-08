// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { action } from './cliServer';
import { internal } from './_generated/api';
import { r2Config, r2Key, presignGet } from './r2';
import { githubSyncCommitSchema } from '../src/github-sync-types';
import { ForgeError, invariant } from '../src/errors';
import { report } from './errors';
import { PackLimitError } from '../src/git-upload-pack';
import { historyLimit } from './projectHistoryStore';
import { historyReadToken, recordHistoryPack, storeHistoryPack } from './projectHistoryImport';

type Pack = {
  tip: string;
  chunks: { sha256: string; size: number }[];
  bytes: number;
  objects: number;
  packSha1: string;
  at: number;
};

/** One history read: current read access, at most one coalesced catch-up pack
 * when main's GitHub mirror moved past stored history, then presigned GETs for
 * the packs this machine does not have yet. No polling; idle costs nothing. */
export const open = action({
  args: {
    projectId: v.id('hostedProjects'),
    /** Pack SHA-1s already in this machine's history cache. */
    cached: v.optional(v.array(v.string())),
  },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'AUTH_REQUIRED', 'Sign in to read project history.');
      const loaded = await ctx.runQuery(internal.projectHistoryStore.load, {
        projectId: input.projectId,
        actor: user.subject,
      });
      invariant(
        loaded,
        'HISTORY_UNAVAILABLE',
        'This project has no imported Git history. History is stored for projects imported from GitHub.',
      );
      const { row } = loaded;
      const packs: Pack[] = [...loaded.packs];
      const base = {
        status: row.status as string,
        repository: row.repository,
        importCommit: row.importCommit,
        importState: row.importState,
        bytes: row.bytes,
        limitBytes: historyLimit(row),
        ...(row.error ? { error: row.error } : {}),
      };
      if (row.status !== 'ready') return JSON.stringify({ ...base, packs: [] });
      // Main's latest mirrored commit, when the mirror publishes to the imported repository.
      let main: { commit: string; state: string } | null = null;
      let catchUp: { code: string; message: string } | null = null;
      if (loaded.mirror && loaded.mirror.repository.toLowerCase() === row.repository.toLowerCase()) {
        const mapping = githubSyncCommitSchema.parse(JSON.parse(loaded.mirror.mapping));
        main = { commit: mapping.commit, state: mapping.state };
        if (!packs.some(pack => pack.tip === mapping.commit) && mapping.commit !== row.importCommit) {
          try {
            invariant(
              !loaded.morePacks,
              'HISTORY_PACKS_FULL',
              'This project has too many history packs to add one.',
            );
            // One reader fetches; the others read what is stored and are told to retry.
            invariant(
              await ctx.runMutation(internal.projectHistoryStore.claimCatchUp, {
                projectId: input.projectId,
                tip: mapping.commit,
              }),
              'HISTORY_CATCH_UP_RUNNING',
              'Newer history is being fetched by another read; retry in a minute.',
            );
            const haves = [...new Set(packs.map(pack => pack.tip))];
            const stored = await storeHistoryPack(ctx, input.projectId, {
              repository: row.repository,
              want: mapping.commit,
              haves,
              token: await historyReadToken(row.repository, row.owner, row.visibility),
              limitBytes: historyLimit(row) - row.bytes,
            });
            const pack = stored.pack;
            const recorded = await recordHistoryPack(ctx, input.projectId, stored, {
              tip: mapping.commit,
              haves,
              source: 'catch-up',
            });
            if (recorded === 'recorded') {
              packs.push({ tip: mapping.commit, ...pack, at: Date.now() });
              base.bytes += pack.bytes;
            } else if (recorded === 'duplicate') {
              const again = await ctx.runQuery(internal.projectHistoryStore.load, {
                projectId: input.projectId,
              });
              packs.splice(0, packs.length, ...(again?.packs ?? []));
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
      const covered =
        main && (main.commit === row.importCommit || packs.some(pack => pack.tip === main.commit));
      const cached = new Set(input.cached ?? []);
      const config = r2Config();
      const listed = [];
      for (const pack of packs) {
        const have = cached.has(pack.packSha1);
        listed.push({
          tip: pack.tip,
          packSha1: pack.packSha1,
          bytes: pack.bytes,
          objects: pack.objects,
          chunks: have
            ? []
            : await Promise.all(
                pack.chunks.map(async chunk => ({
                  ...chunk,
                  url: await presignGet(config, r2Key(input.projectId, chunk.sha256)),
                })),
              ),
        });
      }
      return JSON.stringify({
        ...base,
        /** The newest commit stored history reaches on main. */
        head: covered ? main!.commit : (packs.at(-1)?.tip ?? row.importCommit),
        headState: covered ? main!.state : packs.length <= 1 ? row.importState : null,
        main,
        ...(catchUp ? { catchUp } : {}),
        packs: listed,
      });
    } catch (error) {
      return report(error);
    }
  },
});
