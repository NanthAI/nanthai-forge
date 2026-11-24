// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { SealedReply } from './sealed-verify.js';
import type { PersonCheckpoint, SealedProposal } from './sealed-future-records.js';
import { bytes, checkTree, fullReply, number, proposal, record, roster } from './sealed-schema.js';

/** Exact schemas apply to online, cached, journaled and directly supplied verifier records alike. */
export function decodeSealedReply(value: unknown): SealedReply {
  checkTree(value, fullReply, fullReply);
  return copyBuffers(value) as SealedReply;
}
function copyBuffers(value: unknown): unknown {
  const copies = new Map<object, unknown>();
  const copy = (input: unknown): unknown => {
    if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    if (!input || typeof input !== 'object') return input;
    if (copies.has(input)) return copies.get(input);
    const output: unknown[] | Record<string, unknown> = Array.isArray(input) ? [] : {};
    copies.set(input, output);
    for (const [key, field] of Object.entries(input))
      Object.defineProperty(output, key, {
        value: copy(field),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return output;
  };
  return copy(value);
}
/** Checkpoints and their rosters reject unsigned fields before they become trust anchors. */
export function decodePersonCheckpoint(value: unknown): PersonCheckpoint {
  record({ roster, rosterHash: bytes(32), at: number, signature: bytes(64) })(value);
  return copyBuffers(value) as PersonCheckpoint;
}
/** A proposal from any source is checked by the same per-record schema as a reply's, with no extra fields. */
export function decodeSealedProposal(value: unknown): SealedProposal {
  proposal(value);
  return copyBuffers(value) as SealedProposal;
}
