// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import { equalBytes } from './sealed-portable.js';

/** Portable record transport, deliberately independent of authenticated format frames.
 * JSON carries public structure; binary fields stay raw, without base64 expansion.
 * No repository code, constructor, hook or signature runs while decoding. */
export function encodeSealedWire(value: unknown): Uint8Array {
  const blocks: Uint8Array[] = [];
  const header = JSON.stringify(value, function (this: Record<string, unknown>, key: string, field: unknown) {
    const original = this[key];
    if (original instanceof ArrayBuffer || ArrayBuffer.isView(original)) {
      const index = blocks.length;
      blocks.push(
        original instanceof ArrayBuffer
          ? new Uint8Array(original)
          : new Uint8Array(original.buffer, original.byteOffset, original.byteLength),
      );
      return { $sealedBytes: index };
    }
    return field;
  });
  const text = new TextEncoder().encode(header),
    size = 12 + text.length + blocks.reduce((n, b) => n + 4 + b.length, 0);
  const out = new Uint8Array(size),
    view = new DataView(out.buffer);
  out.set([0x46, 0x53, 0x53, 1]);
  view.setUint32(4, text.length);
  view.setUint32(8, blocks.length);
  out.set(text, 12);
  let offset = 12 + text.length;
  for (const block of blocks) {
    view.setUint32(offset, block.length);
    out.set(block, offset + 4);
    offset += 4 + block.length;
  }
  return out;
}
export function decodeSealedWire(
  bytes: Uint8Array,
  binary: (view: Uint8Array) => unknown = view => view,
): unknown {
  const bad = (ok: unknown) => invariant(ok, 'SECRETS_FORMAT_REFUSED', 'Malformed sealed record transport.');
  bad(bytes.length >= 12 && bytes[0] === 0x46 && bytes[1] === 0x53 && bytes[2] === 0x53 && bytes[3] === 1);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    headerLength = view.getUint32(4),
    count = view.getUint32(8);
  bad(headerLength <= bytes.length - 12 && count <= (bytes.length - 12 - headerLength) / 4);
  const blocks: Uint8Array[] = [];
  let offset = 12 + headerLength;
  for (let i = 0; i < count; i++) {
    bad(offset + 4 <= bytes.length);
    const length = view.getUint32(offset);
    offset += 4;
    bad(length <= bytes.length - offset);
    blocks.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  bad(offset === bytes.length);
  // A byte-exact round trip instead of { fatal: true }: one rule in Node and the Convex V8 runtime,
  // refusing invalid UTF-8 and a leading BOM without relying on decoder options.
  const header = bytes.subarray(12, 12 + headerLength),
    text = new TextDecoder().decode(header);
  bad(equalBytes(new TextEncoder().encode(text), header));
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    bad(false);
  }
  const holder = { root },
    pending: Record<string, unknown>[] = [holder];
  for (let i = 0; i < pending.length; i++) {
    const node = pending[i]!;
    for (const [key, field] of Object.entries(node)) {
      if (!field || typeof field !== 'object') continue;
      if (!Array.isArray(field) && Object.hasOwn(field, '$sealedBytes')) {
        const index = (field as { $sealedBytes: number }).$sealedBytes;
        bad(
          Object.keys(field).length === 1 &&
            Number.isSafeInteger(index) &&
            index >= 0 &&
            index < blocks.length,
        );
        Object.defineProperty(node, key, {
          value: binary(blocks[index]!),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else pending.push(field as Record<string, unknown>);
    }
  }
  return holder.root;
}
