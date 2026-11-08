// SPDX-License-Identifier: Apache-2.0
// Signed CLI releases (docs/operations/cli-update.md, "Signed releases"). The updater checks a new
// release with the keys compiled into the build that is already installed, before it downloads,
// installs dependencies for or builds the new State.
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { ForgeError } from './errors.js';
import { cliReleaseStatement, type CliReleaseSignature } from './cli-release-signature.js';
import { CLI_RELEASE_KEYS, type CliReleaseKey } from './cli-release-keys.js';
export { CLI_RELEASE_KEYS, type CliReleaseKey };

/** The transition switch. While false, a release without a signature from a listed key installs as
 * before (one log line). Turn it on only after `nforge cli release-verify` passes on recent signed
 * States (docs/operations/cli-update.md, "Automated signer"). */
export const CLI_RELEASE_SIGNATURES_REQUIRED = false;

/** While signatures are required and one is still missing, the updater keeps the current build
 * and looks again no sooner than this (one small read per attempt, no alert). */
export const CLI_RELEASE_SIGNATURE_RETRY_MS = 60_000;

export type CliReleaseTrust = { keys: readonly CliReleaseKey[]; required: boolean };
export const cliReleaseTrust = (): CliReleaseTrust => ({
  keys: CLI_RELEASE_KEYS,
  required: CLI_RELEASE_SIGNATURES_REQUIRED,
});

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const rawPublicKey = (publicKey: string) => {
  const raw = Buffer.from(publicKey, 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== publicKey)
    throw new ForgeError(
      'CLI_RELEASE_KEY_INVALID',
      'A release key must be a raw 32-byte Ed25519 key in base64.',
    );
  return raw;
};
const publicKeyObject = (publicKey: string) =>
  createPublicKey({
    key: Buffer.concat([SPKI_ED25519, rawPublicKey(publicKey)]),
    format: 'der',
    type: 'spki',
  });
export const cliReleaseKeyId = (publicKey: string) =>
  createHash('sha256').update(rawPublicKey(publicKey)).digest('hex').slice(0, 16);

/** Raw base64 public key of an Ed25519 private or public key. */
export function cliReleasePublicKey(key: KeyObject) {
  const der = createPublicKey(key).export({ format: 'der', type: 'spki' });
  if (der.length !== 44 || !der.subarray(0, 12).equals(SPKI_ED25519))
    throw new ForgeError('CLI_RELEASE_KEY_INVALID', 'Release keys are Ed25519.');
  return der.subarray(12).toString('base64');
}

/** Sign one State with a PKCS#8 PEM private key (the owner's step; the key stays in memory).
 * `release` makes a v2 signature that carries the release number; `nforge cli release-sign`
 * always passes one. Without it the result is a v1 signature (made before release numbers). */
export function signCliRelease(
  privateKeyPem: string,
  projectId: string,
  head: string,
  release?: number,
): CliReleaseSignature {
  const key = createPrivateKey(privateKeyPem);
  const publicKey = cliReleasePublicKey(key);
  return {
    keyId: cliReleaseKeyId(publicKey),
    signature: sign(null, Buffer.from(cliReleaseStatement(projectId, head, release)), key).toString('base64'),
    ...(release === undefined ? {} : { release }),
  };
}

export type CliReleaseVerdict =
  /** `release` is the signed release number; absent for a v1 signature (no number). */
  | { status: 'verified'; keyId: string; release?: number }
  /** No signature from a listed key (none stored, unknown keys only, or the read failed). */
  | { status: 'unsigned'; reason: string }
  /** A listed key's signature that does not match this State. */
  | { status: 'invalid'; reason: string }
  /** A valid signature whose release number is below the highest this machine installed. */
  | { status: 'downgrade'; reason: string; release: number; installed: number };

/** Pure decision for one State. Signatures from keys this build does not list are ignored: storage
 * is untrusted, so they count as missing, never as valid or as a reason to refuse. A numbered (v2)
 * signature wins over a v1 one; a stored number is only trusted because it is signed. */
export function verifyCliRelease(input: {
  projectId: string;
  head: string;
  signatures: readonly CliReleaseSignature[] | null;
  keys: readonly CliReleaseKey[];
}): CliReleaseVerdict {
  if (!input.signatures) return { status: 'unsigned', reason: 'release signatures could not be read' };
  let invalid: string | null = null,
    legacy: CliReleaseVerdict | null = null;
  for (const key of input.keys) {
    for (const signed of input.signatures.filter(s => s.keyId === key.id)) {
      const statement = Buffer.from(cliReleaseStatement(input.projectId, input.head, signed.release));
      const bytes = Buffer.from(signed.signature, 'base64');
      let ok = false;
      try {
        ok = bytes.length === 64 && verify(null, statement, publicKeyObject(key.publicKey), bytes);
      } catch {
        ok = false;
      }
      if (ok && signed.release !== undefined)
        return { status: 'verified', keyId: key.id, release: signed.release };
      if (ok) legacy ??= { status: 'verified', keyId: key.id };
      else invalid = `the signature from release key ${key.id} does not match this State`;
    }
  }
  if (legacy) return legacy;
  if (invalid) return { status: 'invalid', reason: invalid };
  return {
    status: 'unsigned',
    reason: input.signatures.length
      ? 'no signature from a release key this build trusts'
      : 'no release signature yet',
  };
}
