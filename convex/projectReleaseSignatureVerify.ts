// SPDX-License-Identifier: Apache-2.0
// Server-side check of release-key signatures (docs/operations/cli-update.md, "Automated signer").
// Pure computation before any database read, so a wrong signature costs one refused call and
// writes nothing. Runs in the default Convex runtime: @noble/curves is plain JavaScript.
import { ed25519 } from '@noble/curves/ed25519.js';
import { invariant } from '../src/errors';
import { CLI_RELEASE_KEYS, type CliReleaseKey } from '../src/cli-release-keys';

const bytes = (base64: string) => Uint8Array.from(atob(base64), c => c.charCodeAt(0));
const encoder = new TextEncoder();

/** True only when `signature` is a valid Ed25519 signature over `statement` by the listed key
 * `keyId`. Strict RFC 8032 rules (no ZIP-215 leniency), like the CLI's node:crypto check. */
export function listedKeySigned(
  keyId: string,
  signature: string,
  statement: string,
  keys: readonly CliReleaseKey[] = CLI_RELEASE_KEYS,
) {
  const key = keys.find(entry => entry.id === keyId);
  if (!key) return false;
  try {
    const raw = bytes(signature);
    return (
      raw.length === 64 &&
      ed25519.verify(raw, encoder.encode(statement), bytes(key.publicKey), { zip215: false })
    );
  } catch {
    return false;
  }
}

/** Refuses with RELEASE_SIGNATURE_INVALID unless a listed key signed `statement`. */
export function requireListedKeySigned(
  keyId: string,
  signature: string,
  statement: string,
  keys?: readonly CliReleaseKey[],
) {
  invariant(
    listedKeySigned(keyId, signature, statement, keys),
    'RELEASE_SIGNATURE_INVALID',
    'Only a signature from a listed release key that verifies for this project, State and release is accepted without a sign-in.',
  );
}
