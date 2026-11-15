// SPDX-License-Identifier: Apache-2.0
import type { ActionCtx, MutationCtx } from './_generated/server';
import { isDeviceIdentity } from './cliServer';
import { invariant } from '../src/errors';
/** Device credentials never substitute for the person at the selected owner-only boundary. */
export async function requireOwnerPerson(ctx: Pick<ActionCtx | MutationCtx, 'auth'>, what: string) {
  const user = await ctx.auth.getUserIdentity();
  invariant(
    user && !isDeviceIdentity(user),
    'PROJECT_UNAVAILABLE',
    `Only the owner person can ${what}; open Forge in a browser.`,
  );
  return user;
}
