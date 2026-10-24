// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from 'node:async_hooks';
const observer = new AsyncLocalStorage<(operationId: string, code: string, retries: number) => void>();
export const withRetryObservation = <T>(
  capture: (operationId: string, code: string, retries: number) => void,
  run: () => T,
) => observer.run(capture, run);
export const exhaustedWorkRetries = (operationId: string, code: string, retries: number) =>
  observer.getStore()?.(operationId, code, retries);
