'use node';
// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalAction } from './cliServer';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { currentAccess } from './access';
import { ForgeError } from '../src/errors';
import { hostedPaths } from '../src/hosted-paths';

/** Cleanup identities survive access loss. Locations require a fresh provider and grant check. */
export const read = internalAction({
  args: { rows: v.any() },
  returns: v.any(),
  handler: async (ctx, { rows }) => {
    const actor = (await ctx.auth.getUserIdentity())?.subject;
    const access = new Map<string, boolean>();
    const removed = new Set<string>();
    const pins = new Map<string, Doc<'imports'>>();
    for (const row of rows as Record<string, unknown>[]) {
      const id = row.importId as Id<'imports'> | undefined;
      if (!id || access.has(id)) continue;
      let allowed = false;
      try {
        const { job } = await currentAccess(ctx, id, actor);
        pins.set(id, job);
        allowed = true;
      } catch (error) {
        if (!(
          error instanceof ForgeError && ['GITHUB_UNAVAILABLE', 'GITHUB_SETUP_REQUIRED'].includes(error.code)
        ))
          throw error;
      }
      access.set(id, allowed);
    }
    // Recheck every policy after all provider calls, including revocation while another import was checked.
    for (const [key, allowed] of access) {
      const id = key as Id<'imports'>;
      const latest = await ctx.runQuery(internal.imports.get, { id });
      if (latest?.removal) removed.add(id);
      if (!allowed) continue;
      const job = pins.get(id)!;
      access.set(
        id,
        Boolean(
          latest &&
          !latest.removal &&
          latest.owner === job.owner &&
          latest.repository === job.repository &&
          latest.ref === job.ref &&
          (latest.visibility === 'public' ||
            latest.owner === actor ||
            (actor && (await ctx.runQuery(internal.sharing.allowed, { id, reader: actor })))),
        ),
      );
    }
    return (rows as Record<string, unknown>[])
      .filter(row => !('route' in row || 'active' in row) || !removed.has(String(row.importId)))
      .map(row => {
        if (!row.importId || access.get(String(row.importId))) return hostedPaths(row);
        const result = { ...row };
        const route = row.route as { file?: string; symbol?: string } | undefined;
        const locations = [
          row.repository,
          row.ref,
          row.sourceId,
          row.gitHead,
          route?.file,
          route?.symbol,
          ...(Array.isArray(row.files) ? row.files : []),
        ];
        if (
          typeof result.name === 'string' &&
          (/[\\/]/.test(result.name) ||
            locations.some(
              location => typeof location === 'string' && location && String(result.name).includes(location),
            ))
        )
          result.name = 'route' in result ? 'Saved view' : 'tools' in result ? 'Agent grant' : 'Source Zone';
        for (const key of ['repository', 'ref', 'sourceId', 'gitHead']) if (key in result) result[key] = '';
        if ('files' in result) result.files = [];
        if ('seenHead' in result) result.seenHead = null;
        if ('route' in result) result.route = { view: 'home', state: '', file: '', line: 0 };
        return hostedPaths(result);
      });
  },
});
