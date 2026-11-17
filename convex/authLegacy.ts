// SPDX-License-Identifier: Apache-2.0
import { v, type Infer } from 'convex/values';
import { type ActionCtx, accountAction } from './cliServer';
import { internal } from './_generated/api';
import { convexFetch, networkTimeout } from './networkFetch';
import { invariant } from '../src/errors';
import { report } from './errors';
import {
  authenticationResponse,
  creationOptions,
  registrationResponse,
  registrationResult,
  requestOptions,
} from './authPasskeyWire';

/** A provider session is proven server-to-server on each leg, never by a handle or email.
 * The internal granting mutation also checks this request's original provider identity.
 * A remote provider cannot participate in the Convex transaction; no atomicity across
 * those services is claimed. Clerk remains available until migration is verified. */
export async function liveLegacySession(
  ctx: ActionCtx,
  sessionId: string,
  request: typeof fetch = convexFetch,
) {
  const identity = await ctx.auth.getUserIdentity();
  invariant(
    identity &&
      process.env.CLERK_JWT_ISSUER_DOMAIN &&
      identity.issuer === process.env.CLERK_JWT_ISSUER_DOMAIN,
    'AUTH_REQUIRED',
    'Sign in to your existing Forge account.',
  );
  const secret = process.env.CLERK_SECRET_KEY;
  invariant(secret, 'AUTH_CONFIGURATION', 'Existing-account linking is not configured.');
  const response = await request(`https://api.clerk.com/v1/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${secret}` },
    redirect: 'error',
    signal: networkTimeout(30000),
  });
  invariant(response.ok, 'AUTH_REQUIRED', 'Sign in to your existing Forge account.');
  const session = (await response.json()) as { id?: string; user_id?: string; status?: string };
  invariant(
    session.id === sessionId && session.user_id === identity.subject && session.status === 'active',
    'AUTH_REQUIRED',
    'Sign in to your existing Forge account.',
  );
  return { accountKey: identity.subject, sessionId };
}
export const start = accountAction('same')({
  args: { sessionId: v.string(), operationId: v.string() },
  returns: v.union(
    v.object({ step: v.literal('authenticate'), options: requestOptions }),
    v.object({ step: v.literal('register'), options: creationOptions }),
  ),
  handler: async (
    ctx,
    { sessionId, operationId },
  ): Promise<
    | { step: 'authenticate'; options: Infer<typeof requestOptions> }
    | { step: 'register'; options: Infer<typeof creationOptions> }
  > => {
    try {
      return await ctx.runMutation(internal.authLegacyStore.start, {
        ...(await liveLegacySession(ctx, sessionId)),
        operationId,
      });
    } catch (error) {
      return report(error);
    }
  },
});
export const confirm = accountAction('same')({
  args: { sessionId: v.string(), operationId: v.string(), response: authenticationResponse },
  returns: creationOptions,
  handler: async (ctx, args): Promise<Infer<typeof creationOptions>> => {
    try {
      return await ctx.runMutation(internal.authLegacyStore.confirm, {
        ...(await liveLegacySession(ctx, args.sessionId)),
        operationId: args.operationId,
        response: args.response,
      });
    } catch (error) {
      return report(error);
    }
  },
});
export const finish = accountAction('same')({
  args: { sessionId: v.string(), operationId: v.string(), response: registrationResponse },
  returns: registrationResult,
  handler: async (ctx, args): Promise<Infer<typeof registrationResult>> => {
    try {
      return await ctx.runMutation(internal.authLegacyStore.finish, {
        ...(await liveLegacySession(ctx, args.sessionId)),
        operationId: args.operationId,
        response: args.response,
      });
    } catch (error) {
      return report(error);
    }
  },
});
