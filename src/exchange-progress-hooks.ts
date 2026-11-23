// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Portable hook: only the CLI installs an async-local progress/cancellation reader. */
export type ExchangeProgress = {
  networkRetries?: number;
  signal?: AbortSignal;
  progress?: (phase: string, advanced?: boolean) => void;
};
let reader: (() => ExchangeProgress | undefined) | undefined;
export function registerExchangeProgress(value: () => ExchangeProgress | undefined) {
  reader = value;
}
export const currentExchangeProgress = () => reader?.();
