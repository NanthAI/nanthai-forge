// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from 'node:async_hooks';
const detached = new AsyncLocalStorage<boolean>();
export const withDetachedChecks = <T>(task: () => T) => detached.run(true, task);
/** A long-lived owner hosts local checks even when entered through the CLI. */
export const withOwnerChecks = <T>(task: () => T) => detached.run(false, task);
export const detachedChecksRequired = () =>
  detached.getStore() ?? process.argv[1]?.endsWith('/cli.js') === true;
