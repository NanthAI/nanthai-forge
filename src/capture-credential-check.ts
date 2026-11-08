// SPDX-License-Identifier: Apache-2.0
import { readSource } from './files.js';
import { scanSecretText, SECRET_SCAN_MAX_FILE_BYTES } from './secret-scan.js';

/** Why a new, untracked, not-ignored file that a credential-looking name flagged
 * (`captureExclusion` → `sensitive-name`) stays out of a save, or null to save it.
 * The name is only a prompt: the bytes go through the landing secret scan's own
 * patterns, so a test certificate, a public cert or a token-free `.npmrc` is saved.
 * Held: content the scan calls a credential (`secret-content`) and files it cannot
 * read as text (binary keystores, links, over 1 MiB). Local credential files
 * (`localCredentialName`) are held before this. One bounded read per flagged file;
 * tracked and ignored paths never reach here. */
export function credentialNameHold(root: string, path: string, size: number) {
  if (size > SECRET_SCAN_MAX_FILE_BYTES) return 'sensitive-name';
  let bytes: Buffer | null;
  try {
    bytes = readSource(root, path, SECRET_SCAN_MAX_FILE_BYTES);
  } catch {
    return 'sensitive-name';
  }
  if (!bytes || bytes.subarray(0, 8192).includes(0)) return 'sensitive-name';
  return scanSecretText(path, bytes.toString('utf8')).length ? 'secret-content' : null;
}
