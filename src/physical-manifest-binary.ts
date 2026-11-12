// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
const valid = (ok: unknown) =>
  invariant(ok, 'SOURCE_HASH_MISMATCH', 'Physical manifest encoding is invalid.');
const hexBytes = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'));
const noncePattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** A physical identity is an exact immutable key, including maintenance upload nonces. */
export function physicalKey(digest: string, nonce?: string): string {
  valid(/^[a-f0-9]{64}$/.test(digest) && (nonce === undefined || noncePattern.test(nonce)));
  return digest + (nonce === undefined ? '' : `/u/${nonce}`);
}
/** Shared bounded primitives for roots and digest buckets. No Node runtime is required. */
export class PhysicalWriter {
  private bytes = new Uint8Array(256);
  private at = 0;
  private reserve(size: number) {
    if (this.at + size <= this.bytes.length) return;
    const next = new Uint8Array(Math.max(this.bytes.length * 2, this.at + size));
    next.set(this.bytes);
    this.bytes = next;
  }
  constructor(header: number[]) {
    this.bytes = new Uint8Array(Math.max(256, header.length));
    this.bytes.set(header);
    this.at = header.length;
  }
  byte(value: number) {
    valid(Number.isInteger(value) && value >= 0 && value <= 255);
    this.reserve(1);
    this.bytes[this.at++] = value;
  }
  integer(value: number) {
    valid(Number.isSafeInteger(value) && value >= 0);
    do {
      const next = value % 128;
      value = Math.floor(value / 128);
      this.byte(next + (value ? 128 : 0));
    } while (value);
  }
  private hex(value: string) {
    this.reserve(value.length / 2);
    for (let at = 0; at < value.length; at += 2) {
      const high = value.charCodeAt(at),
        low = value.charCodeAt(at + 1);
      this.bytes[this.at++] = (high <= 57 ? high - 48 : high - 87) * 16 + (low <= 57 ? low - 48 : low - 87);
    }
  }
  hash(id: string) {
    physicalKey(id);
    this.hex(id);
  }
  nonce(value?: string) {
    valid(value === undefined || noncePattern.test(value));
    this.byte(value === undefined ? 0 : 1);
    if (value !== undefined) this.hex(value.replaceAll('-', ''));
  }
  finish() {
    return this.bytes.slice(0, this.at);
  }
}
export class PhysicalReader {
  private at = 4;
  constructor(private readonly bytes: Uint8Array) {}
  get remaining() {
    return this.bytes.length - this.at;
  }
  byte() {
    valid(this.remaining > 0);
    return this.bytes[this.at++]!;
  }
  integer() {
    let value = 0,
      multiplier = 1,
      byte: number;
    do {
      valid(multiplier <= 2 ** 49);
      byte = this.byte();
      value += (byte % 128) * multiplier;
      multiplier *= 128;
    } while (byte >= 128);
    valid(Number.isSafeInteger(value) && (multiplier === 128 || byte > 0));
    return value;
  }
  private hex(size: number) {
    valid(this.remaining >= size);
    let id = '';
    const end = this.at + size;
    while (this.at < end) id += hexBytes[this.bytes[this.at++]!]!;
    return id;
  }
  hash() {
    return this.hex(32);
  }
  nonce() {
    const present = this.byte();
    valid(present <= 1);
    if (!present) return undefined;
    const value = this.hex(16);
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
  }
  finish() {
    valid(this.remaining === 0);
  }
}
