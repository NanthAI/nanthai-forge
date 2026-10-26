// SPDX-License-Identifier: Apache-2.0
import { digest } from './hash.js';
/** Name-based UUID for one rebase attempt: the same parent and attempt always map to the same IDs. */
export function pushAttemptId(
  parent: string,
  attempt: number,
  phase: 'push' | 'reconcile' | 'return' | 'capture',
) {
  const hex = digest(`forge-push-attempt:${parent}:${attempt}:${phase}`),
    variant = (8 | (parseInt(hex[16]!, 16) & 3)).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
