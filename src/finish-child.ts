// SPDX-License-Identifier: Apache-2.0
import { sha256 } from '@noble/hashes/sha2.js';
/** Stable child operation identity, shared by native receipts and read-only projections. */
export function finishChild(operationId: string, phase: string, attempt = 0) {
  const bytes = sha256(
    new TextEncoder().encode(
      `forge-agent-finish:${operationId}:${attempt ? `attempt:${attempt}:${phase}` : phase}`,
    ),
  ).slice(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
