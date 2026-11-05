// SPDX-License-Identifier: Apache-2.0
import { presign as sign, type PresignInput } from '../src/r2-presign.js';
import { storageWritesAvailable } from './legacyStoragePause';
export type { PresignInput };
/** Reads stay available during the approved dev pause. Already issued external
 * PUT URLs cannot be revoked; their database publication is paused separately. */
export function presign(input: PresignInput) {
  if (input.method !== 'GET' && input.method !== 'HEAD') storageWritesAvailable();
  return sign(input);
}
