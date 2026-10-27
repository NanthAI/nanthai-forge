// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from 'node:async_hooks';
import { registerExchangeProgress, type ExchangeProgress } from './exchange-progress-hooks.js';
const current = new AsyncLocalStorage<ExchangeProgress>();
registerExchangeProgress(() => current.getStore());
export function withExchangeProgress<T>(progress: ExchangeProgress, run: () => T): T {
  return current.run({ ...current.getStore(), ...progress }, run);
}
