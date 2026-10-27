// SPDX-License-Identifier: Apache-2.0
import type { ContentPin } from './native-exchange.js';

/** Verified bytes only; callers recheck current project access before every hit.
 * This is disposable process memory, not a permission or source-revision cache. */
export class ExchangeDownloadCache {
  private readonly entries = new Map<string, Buffer>();
  private size = 0;
  constructor(private readonly budget = 16 * 1024 * 1024) {}
  get(pin: ContentPin) {
    const bytes = this.entries.get(pin.sha256);
    return bytes?.length === pin.size ? Buffer.from(bytes) : undefined;
  }
  put(pin: ContentPin, bytes: Buffer) {
    // Keep multi-range objects on the ranged path, including fresh authority checks
    // and draining active requests when one fails. Cache only small-content objects.
    if (bytes.length > Math.min(this.budget, 2 * 1024 * 1024)) return;
    const prior = this.entries.get(pin.sha256);
    if (prior) this.size -= prior.length;
    this.entries.delete(pin.sha256);
    while (this.size + bytes.length > this.budget) {
      const key = this.entries.keys().next().value!;
      this.size -= this.entries.get(key)!.length;
      this.entries.delete(key);
    }
    this.entries.set(pin.sha256, Buffer.from(bytes));
    this.size += bytes.length;
  }
}
