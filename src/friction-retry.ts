// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { AsyncLocalStorage } from 'node:async_hooks';
const observer = new AsyncLocalStorage<(operationId: string, code: string, retries: number) => void>();
export const exhaustedWorkRetries = (operationId: string, code: string, retries: number) =>
  observer.getStore()?.(operationId, code, retries);
