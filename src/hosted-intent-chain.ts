// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { digest } from './state/hash.js';

/** Stable successor UUID for a finished Issue Intent. Concurrent starts derive the same identity
 * from the newest Intent, while Item membership and creation order live on the hosted heads. */
export function successorIntentId(id: string): string {
  const h = digest(`forge-intent-successor:${id}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export const intentFinished = (status: string) => status === 'completed' || status === 'abandoned';
