// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { AsyncLocalStorage } from 'node:async_hooks';
import { registerExchangeProgress, type ExchangeProgress } from './exchange-progress-hooks.js';
const current = new AsyncLocalStorage<ExchangeProgress>();
registerExchangeProgress(() => current.getStore());
export function withExchangeProgress<T>(progress: ExchangeProgress, run: () => T): T {
  return current.run({ ...current.getStore(), ...progress }, run);
}
