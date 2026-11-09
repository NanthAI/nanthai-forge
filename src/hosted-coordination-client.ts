// SPDX-License-Identifier: Apache-2.0
// Client side of coordination before the queue (Issue 1eb42254, D2): per-machine memory of hot-file
// notices shown and of the last stack offer, and the package that owns an overlapping file. No server
// call: everything reads the overlap advice the receipt already carries.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { z } from 'zod';
import { laneRegistryDirectory } from './lane-registry.js';
import { packageManifestPath } from './package-graph.js';
import { HOT_FILE_SHOWS } from './hosted-overlap-coordination.js';

const disabled = () => Boolean(process.env.NODE_TEST_CONTEXT) && !process.env.XDG_STATE_HOME;
const stateFile = (kind: string, laneId: string) =>
  join(dirname(laneRegistryDirectory()), kind, `${laneId}.json`);
function readState<T>(kind: string, laneId: string, schema: z.ZodType<T>): T | null {
  if (disabled()) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(stateFile(kind, laneId), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
function writeState(kind: string, laneId: string, value: unknown) {
  if (disabled()) return;
  try {
    const target = stateFile(kind, laneId);
    if (value === null) return rmSync(target, { force: true });
    const temporary = join(dirname(target), `.${laneId}.${randomUUID()}`);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify(value));
    renameSync(temporary, target);
  } catch {
    /* Advisory: lost memory only repeats a notice or skips an automatic stack. */
  }
}

const shownSchema = z.record(z.string(), z.number().int().nonnegative());
type Items = { unacknowledgedOverlaps: { items: { reason?: string; file: string }[] } };
/** Hot-file notices are capped per path per Lane on this machine (HOT_FILE_SHOWS): once shown that
 * often, the item leaves the receipt. Other items are untouched. Returns the advice to show. */
export function limitHotFiles<T extends Items>(laneId: string, advice: T): T {
  const items = advice.unacknowledgedOverlaps.items;
  if (!items.some(item => item.reason === 'hot-file')) return advice;
  const shown = readState('hot-files', laneId, shownSchema) ?? {};
  const kept = items.filter(item => item.reason !== 'hot-file' || (shown[item.file] ?? 0) < HOT_FILE_SHOWS);
  for (const item of kept) if (item.reason === 'hot-file') shown[item.file] = (shown[item.file] ?? 0) + 1;
  writeState('hot-files', laneId, shown);
  return { ...advice, unacknowledgedOverlaps: { ...advice.unacknowledgedOverlaps, items: kept } };
}

const offerSchema = z.object({ peerLaneId: z.uuid(), mode: z.enum(['offer', 'auto']) });
/** The last stack offer a receipt carried for this Lane; a receipt without one clears it. */
export const rememberStackOffer = (
  laneId: string,
  offer: { peerLaneId: string; mode: 'offer' | 'auto' } | undefined,
) => writeState('stack-offer', laneId, offer ? { peerLaneId: offer.peerLaneId, mode: offer.mode } : null);
/** The peer an automatic stack (project setting stacking:auto) should use at this Lane's next sync. */
export function autoStackPeer(laneId: string) {
  const offer = readState('stack-offer', laneId, offerSchema);
  return offer?.mode === 'auto' ? offer.peerLaneId : undefined;
}

/** The package directory that owns `file` ("." for the repository root package), from the manifests
 * in the checkout's file list; null when no manifest encloses it. One pass over the paths. */
export function owningPackage(paths: Iterable<string>, file: string): string | null {
  const roots = new Set<string>();
  for (const path of paths) if (packageManifestPath(path)) roots.add(posix.dirname(path));
  for (let dir = posix.dirname(file); ; dir = posix.dirname(dir)) {
    if (roots.has(dir)) return dir;
    if (dir === '.' || dir === '/' || dir === '') return null;
  }
}
