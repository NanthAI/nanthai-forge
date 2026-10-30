// SPDX-License-Identifier: Apache-2.0
import { customAction, customCtx, customMutation, customQuery } from 'convex-helpers/server/customFunctions';
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { recordCallerReceipts } from './projectSelfMetricReceiptStore';
import {
  query as baseQuery,
  mutation as baseMutation,
  action as baseAction,
  type QueryCtx,
  type MutationCtx,
  type ActionCtx,
} from './_generated/server';
import { report } from './errors';
import { invariant } from '../src/errors';
export * from './_generated/server';
// Signed credential markers keep scope/revocation enforcement during issuer reconfiguration.
export function isDeviceIdentity(user: { issuer?: string; forgeCredential?: unknown }) {
  return (
    user.forgeCredential !== undefined ||
    Boolean(process.env.FORGE_CLI_ISSUER && user.issuer === process.env.FORGE_CLI_ISSUER)
  );
}
/** Actions cannot read the credential row directly, so each check is a nested
 * query. A positive check is reused for at most this long within one isolate
 * (including an action's own post-run check); revocation and expiry therefore
 * take effect within this bound. Queries and mutations always read the row. */
export const credentialReuseMs = 30_000;
const verified = new Map<string, { at: number; expiresAt: number }>();
async function authorizeAction(ctx: ActionCtx, args: { credentialId: string; owner: string; scope: string }) {
  const key = JSON.stringify([args.credentialId, args.owner, args.scope]),
    now = Date.now(),
    hit = verified.get(key);
  if (hit && now - hit.at < credentialReuseMs && now >= hit.at && hit.expiresAt > now) return;
  verified.delete(key);
  const row = (await ctx.runQuery(
    makeFunctionReference<'query', typeof args, { expiresAt: number }>('deviceStore:authorize'),
    args,
  )) as { expiresAt?: number } | null;
  if (typeof row?.expiresAt !== 'number') return;
  if (verified.size >= 256) verified.delete(verified.keys().next().value!);
  verified.set(key, { at: now, expiresAt: row.expiresAt });
}
export async function guard(ctx: QueryCtx | MutationCtx | ActionCtx, scope: 'cli' | 'coordination') {
  try {
    const user = await ctx.auth.getUserIdentity();
    if (user && isDeviceIdentity(user)) {
      invariant(typeof user.forgeCredential === 'string', 'AUTH_REQUIRED', 'Use a Forge CLI credential.');
      const args = { credentialId: user.forgeCredential, owner: user.subject, scope };
      if ('db' in ctx) {
        // Reuse the same authorization implementation for reactive query dependencies.
        const row = await ctx.db
          .query('cliCredentials')
          .withIndex('by_credentialId', q => q.eq('credentialId', args.credentialId))
          .unique();
        invariant(
          row && !row.revoked && row.expiresAt > Date.now() && row.owner === user.subject,
          'AUTH_REVOKED',
          'Forge login expired or was revoked. Run nforge login.',
        );
        invariant(
          row.scope === 'cli' || scope === 'coordination',
          'AUTH_SCOPE_DENIED',
          'This credential grants coordination only.',
        );
      } else await authorizeAction(ctx, args);
    }
    return {};
  } catch (error) {
    return report(error);
  }
}
export const query = customQuery(
  baseQuery,
  customCtx((ctx: QueryCtx) => guard(ctx, 'cli')),
);
export const mutation = customMutation(
  baseMutation,
  customCtx((ctx: MutationCtx) => guard(ctx, 'cli')),
);
export const action = customAction(baseAction, {
  args: {},
  input: async (ctx: ActionCtx) => {
    await guard(ctx, 'cli');
    return {
      ctx: {},
      args: {},
      onSuccess: async () => {
        await guard(ctx, 'cli');
      },
    };
  },
});
export const coordinationQuery = customQuery(
  baseQuery,
  customCtx((ctx: QueryCtx) => guard(ctx, 'coordination')),
);
export const coordinationMutation = customMutation(
  baseMutation,
  customCtx((ctx: MutationCtx) => guard(ctx, 'coordination')),
);
/** A CLI mutation that may also carry deferred caller receipts (`metricReceipts`).
 * They are written only if the host mutation succeeds, bound to its authorized
 * project and authenticated requester. No extra call is made for them. */
export const receiptMutation = customMutation(baseMutation, {
  args: { metricReceipts: v.optional(v.string()) },
  input: async (ctx: MutationCtx, { metricReceipts }) => {
    await guard(ctx, 'cli');
    return {
      ctx: {},
      args: {},
      onSuccess: async ({ ctx: done, args }) => {
        const user = metricReceipts ? await done.auth.getUserIdentity() : null;
        if (user && typeof args.projectId === 'string')
          await recordCallerReceipts(
            done as MutationCtx,
            args.projectId as Id<'hostedProjects'>,
            user.subject,
            metricReceipts!,
          );
      },
    };
  },
});
