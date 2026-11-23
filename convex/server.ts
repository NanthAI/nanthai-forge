// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import {
  mutation as baseMutation,
  internalMutation as baseInternalMutation,
  action as baseAction,
  internalAction as baseInternalAction,
  type MutationCtx,
  type ActionCtx,
} from './_generated/server';
import { identityContext } from './forgeIdentity';
import { landingRequestBodies } from './projectLandingRequestBody';
import { query as baseQuery, internalQuery as baseInternalQuery, type QueryCtx } from './_generated/server';
import { workRecordWriter, finishWorkRecordWrites } from './projectWorkRecordWriter';
import { cancelledRunWriter, finishCancelledRunWrites } from './projectCancelledRunWrites';
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
    const wrapped = (ctx: MutationCtx, args: unknown) => {
      // Handlers may flush planning writes before deciding whether preparation
      // completed. Keep their context identical to the registered Work writer.
      const records = workRecordWriter(
        cancelledRunWriter(landingRequestBodies(finishReadWriter(identityContext(ctx)))),
      );
      const result = handler(records, args);
      const finish = (value: unknown) => {
        const pending = finishWorkRecordWrites(records);
        const accounting = () => {
          const corrections = finishCancelledRunWrites(records);
          return corrections ? corrections.then(() => value) : value;
        };
        return pending ? pending.then(accounting) : accounting();
      };
      // Preserve synchronous returns and throws. Async handlers may first touch the
      // DB after an await, so wait for their result before deciding whether to flush.
      return result && typeof (result as PromiseLike<unknown>).then === 'function'
        ? Promise.resolve(result).then(finish)
        : finish(result);
    };
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
    const wrapped = (ctx: QueryCtx, args: unknown) =>
      handler(landingRequestBodies(identityContext(ctx)), args);
    return (base as typeof baseQuery)(
      (typeof definition === 'function' ? wrapped : { ...(definition as object), handler: wrapped }) as never,
    );
  }) as B;
}
export const query = withLandingBodies(baseQuery);
export const internalQuery = withLandingBodies(baseInternalQuery);

function withIdentity<B extends typeof baseAction | typeof baseInternalAction>(base: B): B {
  return ((definition: unknown) => {
    const handler =
      typeof definition === 'function'
        ? definition
        : (definition as { handler: (ctx: ActionCtx, args: unknown) => unknown }).handler;
    const wrapped = (ctx: ActionCtx, args: unknown) => handler(identityContext(ctx), args);
    return (base as typeof baseAction)(
      (typeof definition === 'function' ? wrapped : { ...(definition as object), handler: wrapped }) as never,
    );
  }) as B;
}
export const action = withIdentity(baseAction);
export const internalAction = withIdentity(baseInternalAction);
