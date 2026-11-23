// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { createHash } from 'node:crypto';

export function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
export function identity(value: unknown): string {
  return digest(JSON.stringify(value));
}
