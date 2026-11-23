// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { createHash } from 'node:crypto';
import type { GraphPack } from './types.js';

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
