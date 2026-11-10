// SPDX-License-Identifier: Apache-2.0
import { digest } from './state/hash.js';

/** Follow-ups after an Issue's first Intent landed (e4a71127). A planned Issue's first Intent shares
 * the Issue id. Once it is completed or abandoned, the next start creates the Intent whose id is
 * derived from the previous one, so the Issue links to every Intent by id alone: no stored link,
 * no planning write, and two builders starting at once agree on the same Intent. */
export const maxIntentChain = 16;

/** The Intent that continues `id` once `id` finished: a stable UUID v4-shaped digest of it. */
export function successorIntentId(id: string): string {
  const h = digest(`forge-intent-successor:${id}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export const intentFinished = (status: string) => status === 'completed' || status === 'abandoned';
