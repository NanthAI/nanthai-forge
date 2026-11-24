// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { createHmac } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import { invariant } from './errors.js';
import { equalBytes, fixed, frame, uint } from './sealed-format.js';
import { readPrivate, type StoredDeviceKeys } from './sealed-local.js';
import type { SecretPin, SealedReply } from './sealed-verify.js';

export type PinFile = {
  counter: number;
  lostKinds?: number[];
  kinds: Partial<Record<1 | 2 | 3, { pin: SecretPin; cache: SealedReply; fetchedAt: number }>>;
  /** Review L1 (Item 6466c6a5): proposal ids this device applied or rejected, per set kind, newest last. */
  resolvedProposals?: Partial<Record<1 | 2 | 3, Buffer[]>>;
};
export type Index = { counter: number; files: Record<string, { counter: number; kinds: number[] }> };
export const lost = (ok: unknown) =>
  invariant(
    ok,
    'SECRETS_PIN_LOST',
    'Secret trust is missing or older than its counter. Run nforge secret repin.',
  );
export function packed(
  purpose: 'pins' | 'pin-index',
  keys: StoredDeviceKeys,
  counter: number,
  body: Buffer,
  projectId?: Buffer,
) {
  const mac = createHmac('sha256', keys.pinKey)
    .update(
      purpose === 'pins'
        ? frame('pins', fixed(keys.id, 16), fixed(projectId!, 16), uint(counter), body)
        : frame('pin-index', fixed(keys.id, 16), uint(counter), body),
    )
    .digest();
  return serialize({ counter, body, mac });
}
export function unpack<T>(
  path: string,
  purpose: 'pins' | 'pin-index',
  keys: StoredDeviceKeys,
  projectId?: Buffer,
): T {
  const stored = deserialize(readPrivate(path)) as { counter: number; body: Buffer; mac: Buffer };
  const rebuilt = deserialize(packed(purpose, keys, stored.counter, stored.body, projectId)) as typeof stored;
  lost(equalBytes(stored.mac, rebuilt.mac));
  const body = deserialize(stored.body) as T & { counter: number };
  lost(body.counter === stored.counter);
  return body;
}
/** Lost kinds remain remembered even when their old cache bytes could not be recovered. */
export const knownKinds = (file: PinFile) => [
  ...new Set([...Object.keys(file.kinds).map(Number), ...(file.lostKinds ?? [])]),
];
