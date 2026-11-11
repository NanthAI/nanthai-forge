// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
const valid = (ok: unknown) =>
  invariant(ok, 'SOURCE_HASH_MISMATCH', 'Physical manifest encoding is invalid.');
const noncePattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** A physical identity is an exact immutable key, including maintenance upload nonces. */
export function physicalKey(digest: string, nonce?: string): string {
  valid(/^[a-f0-9]{64}$/.test(digest) && (nonce === undefined || noncePattern.test(nonce)));
  return digest + (nonce === undefined ? '' : `/u/${nonce}`);
}
/** Shared bounded primitives for roots and digest buckets. No Node runtime is required. */
export class PhysicalWriter {
  private readonly bytes: number[];
  constructor(header: number[]) {
    this.bytes = [...header];
  }
  byte(value: number) {
    valid(Number.isInteger(value) && value >= 0 && value <= 255);
    this.bytes.push(value);
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
    for (let at = 0; at < value.length; at += 2) this.byte(Number.parseInt(value.slice(at, at + 2), 16));
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
    return Uint8Array.from(this.bytes);
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
    for (let index = 0; index < size; index++) id += this.byte().toString(16).padStart(2, '0');
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
