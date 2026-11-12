// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
type Pin = { sha256: string; size: number };
/** Refresh only after a failed pinned transfer. The logical State never changes,
 * and a second replacement or a broken current root uses the existing fallback. */
export async function refreshPhysicalManifest<T>(
  pin: Pin | undefined,
  read: (pin: Pin) => Promise<T>,
  refresh: () => Promise<Pin | undefined>,
): Promise<T> {
  if (!pin) {
    const current = await refresh();
    invariant(current, 'SOURCE_UNAVAILABLE', 'Selected State manifest is unavailable.');
    return read(current);
  }
  try {
    return await read(pin);
  } catch (error) {
    const current = await refresh();
    if (!current || (current.sha256 === pin.sha256 && current.size === pin.size)) throw error;
    return read(current);
  }
}
