// SPDX-License-Identifier: Apache-2.0
/** Portable hook: only the CLI installs an async-local progress/cancellation reader. */
export type ExchangeProgress = {
  signal?: AbortSignal;
  progress?: (phase: string, advanced?: boolean) => void;
};
let reader: (() => ExchangeProgress | undefined) | undefined;
export function registerExchangeProgress(value: () => ExchangeProgress | undefined) {
  reader = value;
}
export const currentExchangeProgress = () => reader?.();
