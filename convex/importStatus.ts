// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { internal } from './_generated/api';
import { readerAllowed } from './sharing';

// Source-free invalidation only: GitHub authority and source/status bytes stay in
// hosted actions. No public/private repository metadata is exposed by this query.
export const watch = query({
  args: { id: v.id('imports'), zone: v.optional(v.id('sourceZones')) },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { id, zone: zoneId }): Promise<string | null> => {
    const job = await ctx.db.get(id);
    const caller = (await ctx.auth.getUserIdentity())?.subject;
    const zone =
      zoneId && caller
        ? await ctx.runQuery(internal.sourceZones.authorize, { id: zoneId, actor: caller })
        : null;
    if (zone && zone.importId !== id) return null;
    if (
      !job ||
      job.removal ||
      (!zone &&
        job.visibility !== 'public' &&
        job.owner !== caller &&
        !(caller && (await readerAllowed(ctx, id, caller))))
    )
      return null;
    const derivative = job.artifactKey
      ? await ctx.db
          .query('derivedArtifacts')
          .withIndex('by_original_and_kind_and_pin', q =>
            q
              .eq('original', job.artifactKey as import('./_generated/dataModel').Id<'_storage'>)
              .eq('kind', 'hosted-status-v1')
              .eq('pin', ''),
          )
          .unique()
      : null;
    const task = job.task ? await ctx.db.system.get(job.task) : null;
    // Exclude checkedAt/syncRevision: a read's own observation must not retrigger
    // itself. Webhook changes to upstream head/authority still invalidate it.
    return bytesToHex(
      sha256(
        new TextEncoder().encode(
          JSON.stringify([
            job.generation,
            job.owner,
            job.visibility,
            job.repository,
            job.ref,
            job.syncEventRevision ?? null,
            job.phase,
            job.processed,
            job.total,
            job.error ?? null,
            job.head ?? null,
            job.artifactKey ?? null,
            derivative?.removed ? null : (derivative?.digest ?? null),
            job.sync?.result ?? null,
            job.sync?.head ?? null,
            task?.state.kind ?? null,
            zone?.revision ?? null,
          ]),
        ),
      ),
    );
  },
});
