// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { lstatSync, opendirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { laneScratchPath } from './forge-cache-paths.js';
import { canonicalRoot } from './root-paths.js';

const statusLimits = { entries: 4096, milliseconds: 25 };

/** Count allocated blocks, starting with scratch so a large checkout cannot hide it.
 * Partial counts are lower bounds. Walks neither follow links nor read file contents. */
export function laneDiskUsage(checkoutRoot: string, limits = statusLimits) {
  let root = checkoutRoot;
  try {
    root = canonicalRoot(checkoutRoot);
  } catch {
    // Inspection below reports partial coverage for an unreadable checkout.
  }
  const scratch = join(root, laneScratchPath);
  const deadline = performance.now() + limits.milliseconds;
  let remaining = limits.entries;
  const walk = (start: string, skip?: string) => {
    const paths = [start];
    let bytes = 0;
    let complete = true;
    try {
      while (paths.length > 0) {
        if (remaining <= 0 || performance.now() >= deadline) return { bytes, complete: false };
        const path = paths.pop()!;
        remaining--;
        const stat = lstatSync(path, { throwIfNoEntry: false });
        if (!stat) continue;
        if (typeof stat.blocks === 'number') bytes += stat.blocks * 512;
        else complete = false;
        if (!stat.isDirectory()) continue;
        const directory = opendirSync(path);
        try {
          for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
            const child = join(path, entry.name);
            if (child === skip) continue;
            if (paths.length >= remaining || performance.now() >= deadline) {
              complete = false;
              break;
            }
            paths.push(child);
          }
        } finally {
          directory.closeSync();
        }
      }
    } catch {
      complete = false;
    }
    return { bytes, complete };
  };
  // A symlinked .forge could otherwise lead the scratch-first walk outside the checkout.
  let scratchUsage = { bytes: 0, complete: true };
  let scratchThresholdBytes: number | null = null;
  try {
    const forge = lstatSync(join(root, '.forge'), { throwIfNoEntry: false });
    if (forge?.isDirectory()) scratchUsage = walk(scratch);
    else if (forge) scratchUsage.complete = false;
  } catch {
    scratchUsage.complete = false;
  }
  try {
    const fs = statfsSync(root);
    scratchThresholdBytes = Math.floor((fs.bavail * fs.bsize) / 10);
  } catch {
    // Size readings still work without a free-space probe.
  }
  const checkout = walk(root, scratch);
  return {
    bytes: checkout.bytes + scratchUsage.bytes,
    complete: checkout.complete && scratchUsage.complete,
    scratchBytes: scratchUsage.bytes,
    scratchComplete: scratchUsage.complete,
    scratchThresholdBytes,
    largeScratch: scratchThresholdBytes !== null && scratchUsage.bytes > scratchThresholdBytes,
  };
}
