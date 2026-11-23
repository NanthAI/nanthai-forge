// SPDX-License-Identifier: Apache-2.0
// T18: no secret value and no device or set key in any stored row, call or local file of a sealed journey.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serialize } from 'node:v8';

const sha = value => createHash('sha256').update(value).digest();
/** Every file under `directory`, by relative path. */
export function localFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory()
      ? localFiles(join(directory, entry.name), `${prefix}${entry.name}/`)
      : [[`${prefix}${entry.name}`, readFileSync(join(directory, entry.name))]],
  );
}
/** A device's private keys: what must never leave its own key store. */
export const deviceSecrets = keys => {
  const secrets = [keys.sign, keys.enc, keys.pinKey];
  // A wiped (all-zero) key would match any zero padding and prove nothing.
  for (const key of secrets) assert(key.length === 32 && key.some(byte => byte !== 0), 'device key present');
  return secrets;
};
/** Fails naming `label` when a value (raw, hex, base64, base64url or its SHA-256) or a key appears in `parts`. */
export function assertNoPlaintext(label, parts, { values = [], keys = [] }) {
  const dump = Buffer.isBuffer(parts) ? parts : serialize(parts);
  for (const [i, key] of keys.entries())
    for (const encoding of [null, 'hex', 'base64', 'base64url'])
      assert(
        !dump.includes(encoding ? Buffer.from(key.toString(encoding)) : key),
        `${label}: key ${i} ${encoding ?? 'raw'}`,
      );
  for (const value of values) {
    for (const encoding of ['utf8', 'hex', 'base64', 'base64url'])
      assert(!dump.includes(Buffer.from(value.toString(encoding))), `${label}: value as ${encoding}`);
    assert(!dump.includes(sha(value)), `${label}: value hash`);
    assert(!dump.includes(Buffer.from(sha(value).toString('hex'))), `${label}: value hash hex`);
  }
}
/** Each device's local files: its own key store may hold its own keys, never values, set keys or other keys.
 * Returns the paths checked per device, so a journey can prove its files were there to check. */
export function assertLocalFiles(devices, { values, setKeys }) {
  const all = devices.flatMap(d => deviceSecrets(d.keys)),
    checked = {};
  for (const d of devices)
    for (const [path, bytes] of localFiles(d.directory)) {
      (checked[d.label] ??= []).push(path);
      assertNoPlaintext(`${d.label}:${path}`, bytes, {
        values,
        keys: [
          ...setKeys,
          ...(path === 'device.bin' ? all.filter(k => !deviceSecrets(d.keys).includes(k)) : all),
        ],
      });
    }
  return checked;
}
