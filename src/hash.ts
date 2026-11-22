// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';

export function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
export function identity(value: unknown): string {
  return digest(JSON.stringify(value));
}
