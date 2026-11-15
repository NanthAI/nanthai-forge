// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { action } from './cliServer';
import { internal } from './_generated/api';
import { r2Config, r2Key, presignGet } from './r2';
import { invariant } from '../src/errors';
import { encodeHistoryMetadata, historyMetadataBytes } from '../src/history-log-page';
import { PackTrees } from '../src/git-pack-trees';
import { readR2, treeBudget } from './gitServeTrees';
import { safeRelative } from '../src/safe-relative';
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
    cachedMetadata: v.optional(v.array(v.string())),
    log: v.optional(
      v.object({
        commit: v.optional(v.string()),
        path: v.optional(v.string()),
        limit: v.number(),
        skip: v.number(),
      }),
    ),
  },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    try {
      if (input.log)
        invariant(
          Number.isSafeInteger(input.log.limit) &&
            input.log.limit >= 1 &&
            input.log.limit <= 1000 &&
            Number.isSafeInteger(input.log.skip) &&
            input.log.skip >= 0 &&
            (input.log.path === undefined || safeRelative(input.log.path)) &&
            (input.log.commit === undefined || /^[0-9a-f]{4,40}$/.test(input.log.commit)),
          'BAD_ARGUMENT',
          'Invalid history log selection.',
        );
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
      const selection = {
        ...base,
        head: covered ? main!.commit : (packs.at(-1)?.tip ?? row.importCommit),
        headState: covered ? main!.state : packs.length <= 1 ? row.importState : null,
        main,
        ...(catchUp ? { catchUp } : {}),
      };
      let logFallback: string | undefined;
      if (input.log) {
        const have = new Set(input.cachedMetadata ?? []),
          full = new Set(input.cached ?? []);
        const metadata: { pack: string; data: string }[] = [];
        let readBytes = 0,
          replyBytes = 0;
        for (const pack of packs) {
          if (full.has(pack.packSha1)) {
            logFallback =
              'This selection already has a local Git pack cache; the log uses that existing cache.';
            break;
          }
          if (have.has(pack.packSha1)) continue;
          const scan = new PackTrees(treeBudget, { commits: true });
          let ok = false;
          if (pack.metadataVersion === 1 && pack.trees) {
            const index = await readR2(input.projectId, pack.trees.sha256);
            ok = !!index && scan.loadIndex(index);
          } else {
            // Legacy packs retain the same cold chunk-read count until their client cache warms.
            scan.startPack();
            ok = true;
            for (let i = 0; i < pack.chunks.length; i++) {
              const bytes = await readR2(input.projectId, pack.chunks[i]!.sha256);
              ok = !!bytes && scan.push(bytes, i === pack.chunks.length - 1);
              if (!ok) break;
            }
          }
          readBytes += scan.scanned;
          const encoded = ok ? encodeHistoryMetadata(scan) : null;
          if (!encoded || replyBytes + encoded.length > historyMetadataBytes) {
            logFallback =
              'The server metadata scanner cannot cache this layout within its working budget; this log uses the existing local pack cache.';
            break;
          }
          replyBytes += encoded.length;
          metadata.push({ pack: pack.packSha1, data: encoded.toString('base64') });
        }
        if (!logFallback)
          return JSON.stringify({
            ...selection,
            packs: [],
            metadata,
            metadataPacks: packs.map(pack => pack.packSha1),
            readBytes,
          });
      }
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
        ...(logFallback ? { logFallback } : {}),
      });
    } catch (error) {
      return report(error);
    }
  },
});
