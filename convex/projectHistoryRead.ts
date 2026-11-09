// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { action } from './cliServer';
import { internal } from './_generated/api';
import { r2Config, r2Key, presignGet } from './r2';
import { invariant } from '../src/errors';
import { report } from './errors';
import { historyLimit } from './projectHistoryStore';
import { catchUpHistory } from './projectHistoryImport';

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
      const { main, catchUp, packs, addedBytes } = await catchUpHistory(ctx, input.projectId, loaded);
      base.bytes += addedBytes;
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
