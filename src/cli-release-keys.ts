// SPDX-License-Identifier: Apache-2.0
// The public keys that may sign Forge CLI releases (docs/operations/cli-update.md, "Signed
// releases"). No Node built-ins: the CLI updater and the Convex signature store use the same list.

/** One release signing key: `publicKey` is the raw 32-byte Ed25519 public key, base64.
 * The private key never enters Forge, Convex or this repository; the automated signer holds it
 * only as a GitHub environment secret. */
export type CliReleaseKey = { id: string; publicKey: string };

/** Public keys that may sign Forge CLI releases. Rotation: add the new key in a release signed
 * with an old one, sign with both until every machine runs it, then drop the old key. */
export const CLI_RELEASE_KEYS: readonly CliReleaseKey[] = [
  { id: 'f3b8ac47a969d73d', publicKey: 'CB7z5KMg+wi0RPxtygIY7ubTfLEjieO5Lu8xk4pIjg4=' },
];
