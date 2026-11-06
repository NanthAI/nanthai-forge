// SPDX-License-Identifier: Apache-2.0
import type { ContentPin } from './native-exchange.js';

/** `signDownloads` accepts this many digests per call. */
export const signAheadPage = 100;

/** Sign an exchange's network pins in pages of `signAheadPage`, in the order the caller will read
 * them, instead of once per small byte batch. Each page is signed lazily, by the first batch that
 * needs it, so at most one page of signatures is held ahead of the reads. Batches that need the same
 * page share one call. Pins this plan does not list (for example a local-cache miss that was assumed
 * to hit) still sign on their own through the transport. A failed page fails every batch that needs
 * it, as a failed per-batch signing did. Nothing runs when the transport cannot prepare downloads. */
export function signAhead(
  pins: readonly ContentPin[],
  prepare: ((pins: ContentPin[]) => Promise<void>) | undefined,
): (batch: readonly ContentPin[]) => Promise<void> {
  const position = new Map(pins.map((pin, index) => [pin.sha256, index]));
  const pages = new Map<number, Promise<void>>();
  return async batch => {
    if (!prepare) return;
    const wanted = new Set<number>();
    for (const pin of batch) {
      const at = position.get(pin.sha256);
      if (at !== undefined) wanted.add(Math.floor(at / signAheadPage));
    }
    await Promise.all(
      [...wanted].map(page => {
        let signing = pages.get(page);
        if (!signing) {
          signing = prepare(pins.slice(page * signAheadPage, (page + 1) * signAheadPage));
          pages.set(page, signing);
        }
        return signing;
      }),
    );
  };
}
