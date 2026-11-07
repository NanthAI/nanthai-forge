// SPDX-License-Identifier: Apache-2.0
// Signed CLI releases (docs/operations/cli-update.md, "Signed releases"). The updater checks a new
// release with the keys compiled into the build that is already installed, before it downloads,
// installs dependencies for or builds the new State.
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { ForgeError } from './errors.js';
import { cliReleaseStatement, type CliReleaseSignature } from './cli-release-signature.js';

/** One release signing key: `publicKey` is the raw 32-byte Ed25519 public key, base64.
 * The private key never enters Forge, Convex, CI or this repository. */
export type CliReleaseKey = { id: string; publicKey: string };

/** Public keys that may sign Forge CLI releases. Rotation: add the new key in a release signed
 * with an old one, sign with both until every machine runs it, then drop the old key. */
export const CLI_RELEASE_KEYS: readonly CliReleaseKey[] = [];

/** The transition switch. While false, a release without a signature from a listed key installs as
 * before (one log line). Set it to true only after the first signed release is on every machine. */
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

/** Sign one State with a PKCS#8 PEM private key (the owner's step; the key stays in memory). */
export function signCliRelease(privateKeyPem: string, projectId: string, head: string): CliReleaseSignature {
  const key = createPrivateKey(privateKeyPem);
  const publicKey = cliReleasePublicKey(key);
  return {
    keyId: cliReleaseKeyId(publicKey),
    signature: sign(null, Buffer.from(cliReleaseStatement(projectId, head)), key).toString('base64'),
  };
}

export type CliReleaseVerdict =
  | { status: 'verified'; keyId: string }
  /** No signature from a listed key (none stored, unknown keys only, or the read failed). */
  | { status: 'unsigned'; reason: string }
  /** A listed key's signature that does not match this State. */
  | { status: 'invalid'; reason: string };

/** Pure decision for one State. Signatures from keys this build does not list are ignored: storage
 * is untrusted, so they count as missing, never as valid or as a reason to refuse. */
export function verifyCliRelease(input: {
  projectId: string;
  head: string;
  signatures: readonly CliReleaseSignature[] | null;
  keys: readonly CliReleaseKey[];
}): CliReleaseVerdict {
  if (!input.signatures) return { status: 'unsigned', reason: 'release signatures could not be read' };
  const statement = Buffer.from(cliReleaseStatement(input.projectId, input.head));
  let invalid: string | null = null;
  for (const key of input.keys) {
    for (const signed of input.signatures.filter(s => s.keyId === key.id)) {
      const bytes = Buffer.from(signed.signature, 'base64');
      let ok = false;
      try {
        ok = bytes.length === 64 && verify(null, statement, publicKeyObject(key.publicKey), bytes);
      } catch {
        ok = false;
      }
      if (ok) return { status: 'verified', keyId: key.id };
      invalid = `the signature from release key ${key.id} does not match this State`;
    }
  }
  if (invalid) return { status: 'invalid', reason: invalid };
  return {
    status: 'unsigned',
    reason: input.signatures.length
      ? 'no signature from a release key this build trusts'
      : 'no release signature yet',
  };
}
