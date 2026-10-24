// SPDX-License-Identifier: Apache-2.0
import { customAction, customCtx, customMutation, customQuery } from 'convex-helpers/server/customFunctions';
import { makeFunctionReference } from 'convex/server';
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
      } else
        await ctx.runQuery(
          makeFunctionReference<'query', typeof args, unknown>('deviceStore:authorize'),
          args,
        );
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
