// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';

/** One source commit's project snapshot, never shared across transactions. Authority
 * helpers still run every check and contributor lookup. Their first project read
 * keeps the same OCC dependency; our own project writes invalidate the snapshot.
 * Job, operation and other mutable records deliberately keep their normal reads. */
export function sourceCommitReads(ctx: MutationCtx, projectId: Id<'hostedProjects'>): MutationCtx {
  let selected: Promise<Doc<'hostedProjects'> | null> | undefined;
  const invalidate = () => {
    selected = undefined;
  };
  const db = new Proxy(ctx.db, {
    get(target, key) {
      if (key === 'get')
        return ((...args: unknown[]) => {
          const projectRead =
            args.length === 1
              ? args[0] === projectId
              : args.length === 2 && args[0] === 'hostedProjects' && args[1] === projectId;
          if (!projectRead) return Reflect.apply(target.get, target, args);
          return (selected ??= Reflect.apply(target.get, target, args));
        }) as typeof target.get;
      if (key === 'patch' || key === 'replace' || key === 'delete') {
        const write = target[key].bind(target) as (...args: unknown[]) => Promise<unknown>;
        return async (...args: unknown[]) => {
          const id = args[0] === 'hostedProjects' ? args[1] : args[0];
          if (id !== projectId) return write(...args);
          invalidate();
          try {
            return await write(...args);
          } finally {
            // Also discard a read started while the underlying writer was running.
            invalidate();
          }
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  // Context ports and late journal pages can be accessors. Preserve their live
  // lookup exactly like the existing transaction writer wrappers.
  return new Proxy(ctx, {
    get(target, key, receiver) {
      return key === 'db' ? db : Reflect.get(target, key, receiver);
    },
  });
}
