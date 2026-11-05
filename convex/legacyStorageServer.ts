// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import { pauseFlag } from './legacyStoragePause';
import { storageMutationContext } from './legacyStorageReadOnly';

/** The common server composes its existing builders through this boundary.
 * No DB calls or idle work. Preserve both generated builder argument forms. */
export function pausedBuilder<T extends (definition: never) => unknown>(builder: T): T {
  type Handler = (...args: unknown[]) => unknown;
  return ((definition: { handler: Handler } | Handler) => {
    const run = typeof definition === 'function' ? definition : definition.handler;
    const handler = (...args: unknown[]) => {
      // One env lookup, zero DB reads. Do not resolve the context through a
      // Promise: that probes ctx.then and changes synchronous return/throw timing.
      if (!process.env[pauseFlag]) return run(...args);
      return storageMutationContext(args[0] as MutationCtx).then(ctx => run(ctx, ...args.slice(1)));
    };
    return builder((typeof definition === 'function' ? handler : { ...definition, handler }) as never);
  }) as unknown as T;
}
