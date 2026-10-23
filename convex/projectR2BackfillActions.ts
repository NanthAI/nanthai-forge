// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { action } from './cliServer';
import { backfillPin } from './r2BackfillFields';
import type { Pin } from './r2BackfillRows';
import { r2Config, r2Key, headObject, checksumOf, presignGet } from './r2';
import { invariant } from '../src/errors';
import { report } from './errors';

/** Checks metadata only. Missing keys are reported so the CLI avoids repeat Convex egress. */
export const check = action({
  args: {
    projectId: v.id('hostedProjects'),
    pins: v.array(backfillPin),
    operationId: v.string(),
    commit: v.boolean(),
  },
  returns: v.array(
    v.object({
      id: v.string(),
      status: v.union(v.literal('verified'), v.literal('missing'), v.literal('failed'), v.literal('skipped')),
      url: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (
    ctx,
    { projectId, pins, operationId, commit },
  ): Promise<{ id: string; status: 'verified' | 'missing' | 'failed' | 'skipped'; url: string | null }[]> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to maintain project storage.');
      invariant(pins.length <= 100, 'BAD_ARGUMENT', 'Backfill pages contain at most 100 rows.');
      const rows: Pin[] = await ctx.runQuery(
        makeFunctionReference<'query'>('projectR2Backfill:inspectRows'),
        {
          projectId,
          actor: user.subject,
          pins,
        },
      );
      const config = r2Config(),
        verified: Pin[] = [];
      const results: {
        id: string;
        status: 'verified' | 'missing' | 'failed' | 'skipped';
        url: string | null;
      }[] = await Promise.all(
        pins.map(async pin => {
          if (
            !rows.some(
              row =>
                row.id === pin.id &&
                row.kind === pin.kind &&
                row.storageId === pin.storageId &&
                row.digest === pin.digest &&
                row.size === pin.size &&
                row.location === pin.location,
            )
          )
            return { id: pin.id, status: 'skipped' as const, url: null };
          const head = await headObject(config, r2Key(projectId, pin.digest));
          if (head.status === 'missing') return { id: pin.id, status: 'missing' as const, url: null };
          if (head.status !== 'ok' || head.size !== pin.size || head.checksum !== checksumOf(pin.digest))
            return { id: pin.id, status: 'failed' as const, url: null };
          verified.push(pin);
          return {
            id: pin.id,
            status: 'verified' as const,
            url: await presignGet(config, r2Key(projectId, pin.digest)),
          };
        }),
      );
      if (commit && verified.length) {
        const flipped: string[] = await ctx.runMutation(
          makeFunctionReference<'mutation'>('projectR2Backfill:flip'),
          {
            projectId,
            actor: user.subject,
            operationId,
            pins: verified,
          },
        );
        for (const result of results)
          if (result.status === 'verified' && !flipped.includes(result.id)) {
            result.status = 'skipped';
            result.url = null;
          }
      }
      // Recheck current owner after the network operations, even for HEAD-only verification.
      await ctx.runQuery(makeFunctionReference<'query'>('projectR2Backfill:inspectRows'), {
        projectId,
        actor: user.subject,
        pins: [],
      });
      return results;
    } catch (error) {
      return report(error);
    }
  },
});
