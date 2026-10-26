// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import type { GraphPack } from './types.js';

export function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
export function identity(value: unknown): string {
  return digest(JSON.stringify(value));
}

export function* graphJsonParts(body: GraphPack | Omit<GraphPack, 'id'>): Generator<string> {
  // Preserve JSON byte order without allocating a second whole-graph string.
  yield '{';
  let separator = '';
  for (const [key, value] of Object.entries(body)) {
    yield `${separator}${JSON.stringify(key)}:`;
    if (Array.isArray(value)) {
      yield '[';
      for (let i = 0; i < value.length; i++) {
        if (i) yield ',';
        yield JSON.stringify(value[i]) ?? 'null';
      }
      yield ']';
    } else yield JSON.stringify(value);
    separator = ',';
  }
  yield '}';
}
export function graphIdentity(body: Omit<GraphPack, 'id'>): string {
  const hash = createHash('sha256');
  for (const part of graphJsonParts(body)) hash.update(part);
  return hash.digest('hex');
}
