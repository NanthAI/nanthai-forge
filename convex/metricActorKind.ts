// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MutationCtx } from './_generated/server';
import { isDeviceIdentity } from './cliServer';

/** Metric 5.5 attribution from the signed-in identity, the same rule as acceptanceActor: a device
 * credential is an agent, a browser sign-in is the person. No database read. Undefined when the
 * caller is not the named actor (a scheduled job, or another account). */
export async function callerActorKind(
  ctx: Pick<MutationCtx, 'auth'>,
  actor: string,
): Promise<'agent' | 'person' | undefined> {
  const user = await ctx.auth.getUserIdentity();
  if (!user || user.subject !== actor) return undefined;
  return isDeviceIdentity(user) ? 'agent' : 'person';
}
