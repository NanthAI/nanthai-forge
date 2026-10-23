// SPDX-License-Identifier: Apache-2.0
/** Keep UTF-8 characters intact between byte-paged log reads. Offsets remain byte identities. */
export function checkLogPage(bytes: Uint8Array, offset: number, total: number) {
  const text = new TextDecoder('utf-8').decode(bytes, { stream: offset + bytes.length < total });
  const consumed = new TextEncoder().encode(text).length;
  // Invalid UTF-8 is displayed with replacement characters, without manufacturing byte positions.
  const nextOffset = offset + Math.min(consumed, bytes.length);
  return { available: true, offset, nextOffset, bytes: total, text, more: nextOffset < total };
}
