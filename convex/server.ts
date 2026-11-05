// SPDX-License-Identifier: Apache-2.0
import {
  mutation as baseMutation,
  internalMutation as baseInternalMutation,
  type MutationCtx,
} from './_generated/server';
import { finishReadWriter } from './projectFinishReadWriter';
import { pausedBuilder } from './legacyStorageServer';
// Preserve context accessors instead of eagerly spreading the context. Retired
// functions can return their existing error without touching any runtime port.
function withFinishReads<B extends typeof baseMutation | typeof baseInternalMutation>(base: B): B {
  return ((definition: unknown) => {
    const handler =
      typeof definition === 'function'
        ? definition
        : (definition as { handler: (ctx: MutationCtx, args: unknown) => unknown }).handler;
    const wrapped = (ctx: MutationCtx, args: unknown) => handler(finishReadWriter(ctx), args);
    return (base as typeof baseMutation)(
      (typeof definition === 'function' ? wrapped : { ...(definition as object), handler: wrapped }) as never,
    );
  }) as B;
}
export const mutation = withFinishReads(pausedBuilder(baseMutation));
export const internalMutation = withFinishReads(pausedBuilder(baseInternalMutation));

// Only the reviewed maintenance endpoints use this builder. Their handlers
// require the active transaction fence; tracked-row writes still update reads.
export const maintenanceInternalMutation = withFinishReads(baseInternalMutation);

export * from './_generated/server';
