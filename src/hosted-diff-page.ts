// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HostedCheckoutCache } from './hosted-checkout-cache.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import type { ConvexLaneTransport } from './hosted-lane-transport.js';
import { contextualHunks } from './review-hunks.js';
import { REVIEW_MAX_FILE_BYTES } from './review-hunks-core.js';
import type { ReviewPath } from './source-review-format.js';

// The hunk engine compares at most 1 MiB per version. Bound each page to one such
// pair's worth of source, even when the caller asks for a much larger reply.
const maxSourceBytes = 2 * REVIEW_MAX_FILE_BYTES;
const empty = Buffer.alloc(0);
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
type Diff = ReturnType<typeof contextualHunks>;

function fitDiff(diff: Diff, budget: number, requiredByteBudget: number) {
  const bounded = { ...diff, hunks: [] as Diff['hunks'], truncated: true, requiredByteBudget };
  let remaining = budget - jsonBytes(bounded);
  for (const hunk of diff.hunks) {
    const partial = { ...hunk, lines: [] as typeof hunk.lines, beforeLines: 0, afterLines: 0 };
    // Reserve a comma and room for the counts to grow.
    remaining -= jsonBytes(partial) + 16;
    if (remaining <= 0) break;
    for (const line of hunk.lines) {
      remaining -= jsonBytes(line) + 1;
      if (remaining < 0) break;
      partial.lines.push(line);
      if (line.kind !== 'added') partial.beforeLines++;
      if (line.kind !== 'removed') partial.afterLines++;
    }
    if (partial.lines.length) bounded.hunks.push(partial);
    if (partial.lines.length !== hunk.lines.length) break;
  }
  return bounded;
}

export async function readHostedDiffPage(
  root: string,
  objects: ConvexLaneTransport,
  window: ReviewPath[],
  byteBudget: number,
) {
  // The one metadata page covers both versions of up to 50 paths.
  const blobs = (item: ReviewPath) => [item.before?.blob, item.after?.blob].filter(id => id !== undefined);
  const ids = [...new Set(window.flatMap(blobs))];
  const pins = new Map((ids.length ? await objects.objects(ids) : []).map(pin => [pin.sha256, pin]));
  const selection = [];
  const selectedIds = new Set<string>();
  let plannedBytes = 0,
    ordinaryBytes = 0;
  for (const item of window) {
    const itemIds = blobs(item);
    const sizes = itemIds.map(id => pins.get(id)!.size);
    const size = sizes.reduce((sum, bytes) => sum + bytes, 0);
    if (sizes.some(bytes => bytes > REVIEW_MAX_FILE_BYTES)) {
      selection.push({
        item,
        omission: { path: item.path, reason: 'source-too-large' as const, sourceBytes: size },
      });
      continue;
    }
    if (plannedBytes + size > maxSourceBytes) break;
    // Keep the usual small-file source window. A large pair may still have a small hunk,
    // so let it use the separate source allowance.
    if (size <= byteBudget) {
      if (ordinaryBytes + size > byteBudget) break;
      ordinaryBytes += size;
    }
    plannedBytes += size;
    selection.push({ item });
    for (const id of itemIds) selectedIds.add(id);
  }
  // Reuse signatures from discovery. No per-file descriptor requests.
  const cache = new HostedCheckoutCache(root, {
    objects: async digests => digests.map(id => pins.get(id)!),
    downloadToFile: objects.downloadToFile.bind(objects),
    downloadFiles: objects.downloadFiles.bind(objects),
  });
  let sourceBytes = 0;
  const verified = new Set<string>();
  const materialize = async (ids: string[]) => {
    const pending = [...new Set(ids)].filter(id => !verified.has(id));
    if (!pending.length) return;
    await cache.ensure(pending);
    for (const id of pending) {
      sourceBytes += pins.get(id)!.size;
      verified.add(id);
    }
  };
  // Batch cold downloads to preserve packed R2 runs. Reverify warm files only as
  // they are compared, so paging does not repeatedly hash the unread tail.
  await materialize([...selectedIds].filter(id => !checkoutPathExists(join(cache.objects, id))));

  const read = (id: string | undefined) => (id ? readFileSync(join(cache.objects, id)) : empty);
  const items = [],
    omitted = [];
  let outputBytes = 0;
  for (const { item, omission } of selection) {
    if (omission) {
      omitted.push(omission);
      continue;
    }
    await materialize(blobs(item));
    const before = read(item.before?.blob),
      after = read(item.after?.blob),
      remaining = byteBudget - outputBytes;
    let diff: Diff & { requiredByteBudget?: number } = contextualHunks(before, after, 3, true);
    let size = jsonBytes(diff);
    if (size > remaining) {
      // Context is optional in a tight reply. Save the file for the next pinned page
      // if its changed lines can get more room there.
      diff = contextualHunks(before, after, 0, true);
      size = jsonBytes(diff);
      if (size > remaining) {
        if (items.length) break;
        const bounded = fitDiff(diff, remaining, size);
        diff = bounded;
        size = jsonBytes(bounded);
      }
    }
    outputBytes += size;
    items.push({ ...item, ...diff });
  }
  return {
    items,
    omitted,
    cost: {
      sourceBytes,
      outputBytes,
      downloadedBytes: cache.downloadedBytes,
      metadataPages: ids.length ? 1 : 0,
    },
  };
}
