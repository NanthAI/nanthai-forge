// SPDX-License-Identifier: Apache-2.0
import {
  mutation as baseMutation,
  internalMutation as baseInternalMutation,
  type MutationCtx,
} from './_generated/server';
import { landingRequestBodies } from './projectLandingRequestBody';
import { query as baseQuery, internalQuery as baseInternalQuery, type QueryCtx } from './_generated/server';
import { workRecordWriter } from './projectWorkRecordWriter';
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
    const wrapped = (ctx: MutationCtx, args: unknown) =>
      handler(workRecordWriter(landingRequestBodies(finishReadWriter(ctx))), args);
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

/** Existing query/index contracts receive the same logical request row. */
function withLandingBodies<B extends typeof baseQuery | typeof baseInternalQuery>(base: B): B {
  return ((definition: unknown) => {
    const handler =
      typeof definition === 'function'
        ? definition
        : (definition as { handler: (ctx: QueryCtx, args: unknown) => unknown }).handler;
    const wrapped = (ctx: QueryCtx, args: unknown) => handler(landingRequestBodies(ctx), args);
    return (base as typeof baseQuery)(
      (typeof definition === 'function' ? wrapped : { ...(definition as object), handler: wrapped }) as never,
    );
  }) as B;
}
export const query = withLandingBodies(baseQuery);
export const internalQuery = withLandingBodies(baseInternalQuery);
