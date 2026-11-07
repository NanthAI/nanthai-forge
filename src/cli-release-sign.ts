// SPDX-License-Identifier: Apache-2.0
// Owner steps for signed CLI releases (docs/operations/cli-update.md, "Signed releases"). Only
// public material is ever printed: the key id, the public key and the signature.
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { invariant } from './errors.js';
import { cliInstallation } from './cli-installation.js';
import { cliReleaseSource } from './cli-update-source.js';
import { defaultCliInstallation, readCliSource } from './cli-update.js';
import { cliReleaseNumberSchema } from './cli-release-signature.js';
import {
  CLI_RELEASE_KEYS,
  cliReleaseKeyId,
  cliReleasePublicKey,
  signCliRelease,
  verifyCliRelease,
} from './cli-release-trust.js';

/** `nforge cli release-key --out FILE`: a new Ed25519 key, PKCS#8 PEM, mode 0600, never overwritten. */
export function cliReleaseKey(out: string) {
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(out, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
  const publicKey = cliReleasePublicKey(privateKey);
  return { file: out, keyId: cliReleaseKeyId(publicKey), publicKey };
}

/** `nforge cli release-sign --key FILE [--state STATE --release N]`: sign the configured release
 * project's main (or one State) with its release number and store the signature. The number
 * defaults to main's source revision, which grows with every accepted State; --state needs an
 * explicit --release. One release read (without --state) and one write. */
export async function cliReleaseSign(
  installation: string,
  keyFile: string,
  state?: string,
  source: Pick<ReturnType<typeof cliReleaseSource>, 'current' | 'publishSignature'> = cliReleaseSource(
    readCliSource(installation),
  ),
  releaseNumber?: number,
) {
  invariant(
    (statSync(keyFile).mode & 0o077) === 0,
    'CLI_RELEASE_KEY_EXPOSED',
    'The release key file must be readable by its owner only (chmod 600).',
  );
  const address = readCliSource(installation);
  const main = state ? null : await source.current();
  const head = state ?? main!.head;
  invariant(/^[a-f0-9]{64}$/.test(head), 'BAD_ARGUMENT', 'Use a full Forge State hash.');
  const release = releaseNumber ?? (main && 'sourceRevision' in main ? main.sourceRevision : undefined);
  invariant(
    cliReleaseNumberSchema.safeParse(release).success,
    'BAD_ARGUMENT',
    'Supply --release N (a whole number above every earlier signed release) with --state.',
  );
  const signed = signCliRelease(readFileSync(keyFile, 'utf8'), address.projectId, head, release);
  const listed = verifyCliRelease({
    projectId: address.projectId,
    head,
    signatures: [signed],
    keys: CLI_RELEASE_KEYS,
  });
  const { stored } = await source.publishSignature(head, signed);
  return { head, release, keyId: signed.keyId, stored, listed: listed.status === 'verified' };
}

export async function cliReleaseCommand(command: 'release-key' | 'release-sign', flags: string[]) {
  let installation = cliInstallation() ?? defaultCliInstallation(),
    out: string | undefined,
    key: string | undefined,
    state: string | undefined,
    release: number | undefined;
  while (flags.length) {
    const flag = flags.shift()!,
      value = flags.shift();
    invariant(value, 'BAD_ARGUMENT', 'Use nforge cli --help.');
    if (flag === '--directory') installation = resolve(value);
    else if (flag === '--out' && command === 'release-key') out = resolve(value);
    else if (flag === '--key' && command === 'release-sign') key = resolve(value);
    else if (flag === '--state' && command === 'release-sign') state = value;
    else if (flag === '--release' && command === 'release-sign') {
      invariant(/^\d{1,15}$/.test(value), 'BAD_ARGUMENT', 'Use a whole release number.');
      release = Number(value);
    } else invariant(false, 'BAD_ARGUMENT', 'Use nforge cli --help.');
  }
  if (command === 'release-key') {
    invariant(out, 'BAD_ARGUMENT', 'Supply --out FILE (outside any checkout).');
    return cliReleaseKey(out);
  }
  invariant(key, 'BAD_ARGUMENT', 'Supply --key FILE.');
  return cliReleaseSign(installation, key, state, undefined, release);
}
