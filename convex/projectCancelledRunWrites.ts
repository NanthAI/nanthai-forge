// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';

// Same-transaction accounting runs after the handler's existing queue writes.
// Otherwise a caller holding an earlier request snapshot could overwrite usage
// or record a stale budget sample after cancelling a run. No RPC/timer is used.
const contextKey = Symbol('cancelled-run-accounting');
type AccountingContext = MutationCtx & { [contextKey]?: object };
type DeferredCancellation = { submissions: readonly string[]; apply: () => Promise<void> };
const pending = new WeakMap<object, Map<string, DeferredCancellation>>();
/** CLI custom contexts copy enumerable symbols along with the existing ports. */
export function cancelledRunWriter(ctx: MutationCtx): MutationCtx {
  const identity = {};
  // Do not inspect the underlying context: retired/synchronous handlers may
  // deliberately expose no ports at all. The virtual symbol copies with a CLI
  // custom context, while ordinary context reads retain their existing laziness.
  return new Proxy(ctx, {
    get: (target, key, receiver) => (key === contextKey ? identity : Reflect.get(target, key, receiver)),
    ownKeys: target => [...Reflect.ownKeys(target).filter(key => key !== contextKey), contextKey],
    getOwnPropertyDescriptor: (target, key) =>
      key === contextKey
        ? { configurable: true, enumerable: true, value: identity }
        : Reflect.getOwnPropertyDescriptor(target, key),
  });
}
const key = (ctx: MutationCtx) => (ctx as AccountingContext)[contextKey] ?? ctx;
export function deferCancelledRunWrite(
  ctx: MutationCtx,
  runId: string,
  submissions: readonly string[],
  apply: () => Promise<void>,
) {
  let work = pending.get(key(ctx));
  if (!work) pending.set(key(ctx), (work = new Map()));
  work.set(runId, { submissions, apply });
}
export function hasDeferredCancelledUsage(ctx: MutationCtx, runId: string, submissionId: string): boolean {
  return pending.get(key(ctx))?.get(runId)?.submissions.includes(submissionId) ?? false;
}

export function finishCancelledRunWrites(ctx: MutationCtx): Promise<void> | undefined {
  const work = pending.get(key(ctx));
  if (!work?.size) return;
  pending.delete(key(ctx));
  return (async () => {
    for (const { apply } of work.values()) await apply();
  })();
}
