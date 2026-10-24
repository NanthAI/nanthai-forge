// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from 'node:async_hooks';
const detached = new AsyncLocalStorage<boolean>();
export const withDetachedChecks = <T>(task: () => T) => detached.run(true, task);
export const detachedChecksRequired = () =>
  detached.getStore() === true || process.argv[1]?.endsWith('/cli.js') === true;
