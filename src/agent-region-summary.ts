// SPDX-License-Identifier: Apache-2.0
import { attributionEdits, attributionLines } from './native-text-merge.js';
import { contractDelta, type ContractChange, type ContractSource } from './contract-deps.js';
import type { PeersCache } from './agent-peers-cache.js';

/** One-based base coordinates. Zero lines denotes an insertion before start. */
export type Region = { start: number; lines: number };
type File = { path: string; blob: string; mode?: string };
export type RegionFile = {
  path: string;
  before?: string;
  after?: string;
  regions: Region[] | null;
  structural: boolean;
};
export type RegionSummary = { files: RegionFile[]; contracts: ContractChange[]; size: number };

export function regionEdits(before: Buffer, after: Buffer) {
  if (before.length > 1024 * 1024 || after.length > 1024 * 1024) return null;
  const a = attributionLines(before),
    b = attributionLines(after);
  return a && b ? attributionEdits(a, b) : null;
}

/** Immutable base/head cache, primed on checkpoint/sync. Missing caches rebuild
 * once; pair observations never diff a peer's working directory for prediction. */
export function regionSummary(
  source: ContractSource,
  cache: PeersCache,
  base: string,
  head: string,
  files: () => [File[], File[]],
): RegionSummary {
  const key = `regions-v1:${base}:${head}`;
  const known = cache.read<RegionSummary>(key);
  if (known) return known;
  const [a, b] = files(),
    old = new Map(a.map(file => [file.path, file])),
    now = new Map(b.map(file => [file.path, file]));
  const out: RegionSummary = { files: [], contracts: contractDelta(source, a, b), size: 0 };
  for (const path of [...new Set([...old.keys(), ...now.keys()])].sort()) {
    const before = old.get(path),
      after = now.get(path);
    if (before?.blob === after?.blob && before?.mode === after?.mode) continue;
    const edits = regionEdits(
      before ? source.object(before.blob) : Buffer.alloc(0),
      after ? source.object(after.blob) : Buffer.alloc(0),
    );
    out.files.push({
      path,
      ...(before ? { before: before.blob } : {}),
      ...(after ? { after: after.blob } : {}),
      regions: edits?.map(edit => ({ start: edit.start + 1, lines: edit.end - edit.start })) ?? null,
      // Renames appear at both source and destination. Deletion/rename or
      // competing additions affect the path even when their text is identical.
      structural: !before || !after || before.mode !== after.mode,
    });
    out.size += edits?.reduce((n, edit) => n + edit.end - edit.start + edit.lines.length, 0) ?? 1;
  }
  cache.write(key, out);
  return out;
}

/** Project peer base positions onto my base. Changes inside an intervening edit
 * conservatively cover its replacement. Cache the baseline alignment by blobs. */
export function alignRegions(
  source: ContractSource,
  cache: PeersCache,
  file: RegionFile,
  target: RegionFile,
): Region[] | null {
  if (!file.regions) return null;
  if (file.before === target.before) return file.regions;
  const key = `region-alignment-v1:${file.before ?? 'empty'}:${target.before ?? 'empty'}`;
  type Edits = ReturnType<typeof regionEdits>;
  let edits = cache.read<Edits>(key);
  if (edits === undefined) {
    edits = regionEdits(
      file.before ? source.object(file.before) : Buffer.alloc(0),
      target.before ? source.object(target.before) : Buffer.alloc(0),
    );
    cache.write(key, edits);
  }
  if (!edits) return null;
  const position = (at: number, right: boolean) => {
    let shift = 0;
    for (const edit of edits) {
      if (at < edit.start) break;
      if (at <= edit.end) return edit.start + shift + (right ? edit.lines.length : 0);
      shift += edit.lines.length - (edit.end - edit.start);
    }
    return at + shift;
  };
  return file.regions.map(region => {
    const start = position(region.start - 1, false),
      end = position(region.start - 1 + region.lines, true);
    return { start: start + 1, lines: Math.max(0, end - start) };
  });
}
