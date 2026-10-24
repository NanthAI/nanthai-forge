// SPDX-License-Identifier: Apache-2.0
import { statfsSync } from 'node:fs';
import { ForgeError, invariant } from './errors.js';

export type FreeSpaceProbe = (path: string) => number;
const freeSpace: FreeSpaceProbe = path => {
  const info = statfsSync(path);
  return info.bavail * info.bsize;
};
const threshold = (key: string, fallback: number) => {
  const value = process.env[key] === undefined ? fallback : Number(process.env[key]);
  invariant(
    Number.isFinite(value) && value >= 0,
    'BAD_ARGUMENT',
    `${key} must be a non-negative number of GB.`,
  );
  return value * 1_000_000_000;
};
export function diskGuard(owner: string, probe: FreeSpaceProbe = freeSpace): string[] {
  let available: number;
  try {
    available = probe(owner);
  } catch {
    throw new ForgeError('DISK_PROBE_FAILED', 'Could not measure free space on the owner filesystem.');
  }
  invariant(
    Number.isFinite(available) && available >= 0,
    'DISK_PROBE_FAILED',
    'Free-space probe did not return available bytes.',
  );
  const warn = threshold('FORGE_DISK_WARN_GB', 5),
    block = threshold('FORGE_DISK_BLOCK_GB', 2);
  const details = `${(available / 1_000_000_000).toFixed(2)} GB free on the owner filesystem. Run nforge agent ${JSON.stringify(owner)} clean (dry run) to inspect reclaimable space; nothing is deleted automatically.`;
  if (available < block) throw new ForgeError('DISK_LOW', details);
  return warn > 0 && available <= warn ? [details] : [];
}
