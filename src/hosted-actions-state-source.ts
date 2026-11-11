// SPDX-License-Identifier: Apache-2.0
import {
  downloadPhysicalManifest,
  type PhysicalGrantPlan,
  type SignedPhysicalRun,
} from './physical-manifest-download.js';
import { physicalRunFor } from './physical-manifest-runs.js';
import { invariant } from './errors.js';
import { packRange } from './object-pack-range.js';
import type { PackRunBinding } from './hosted-checkout-runs.js';
import type { SignedDownload } from './blob-download-format.js';
export type StateSourceRow = {
  statePhysical?: { sha256: string; size: number };
  descriptor: { object: { sha256: string; size: number }; recipe: { sha256: string; size: number } | null };
  url: string | null;
  range?: { offset: number; total: number };
  run?: PackRunBinding & { id: number };
  closure?: SignedDownload[];
};
/** Reconstruct per-member rows locally: the server returns only exact physical run grants. */
export async function rowsFromPhysicalRuns(
  plan: PhysicalGrantPlan,
  runs: SignedPhysicalRun[],
  request: (url: string, init?: RequestInit) => Promise<Response>,
  put: (id: string, row: StateSourceRow) => void,
  page: string,
) {
  const reader = await downloadPhysicalManifest(plan, request),
    first = new Set<number>(),
    pending = new Map<string, StateSourceRow>();
  for await (const entry of reader.all(false)) {
    invariant(!entry.recipe, 'SOURCE_HASH_MISMATCH', 'Raw run reply contains a recipe member.');
    const run = physicalRunFor(runs, entry),
      id = run ? runs.indexOf(run as SignedPhysicalRun) : -1;
    invariant(run && id >= 0, 'SOURCE_HASH_MISMATCH', 'Physical run reply omits a State member.');
    const signed = runs[id]!;
    pending.set(entry.sha256, {
      descriptor: { object: { sha256: entry.sha256, size: entry.size }, recipe: null },
      // The shared verifier groups at least two members. A singleton retains
      // its exact-range URL rather than requiring another resolver call.
      url: signed.raw || signed.length === entry.size ? signed.url : null,
      ...(entry.pack
        ? {
            range: packRange(entry)!,
            ...(signed.length === entry.size
              ? {}
              : {
                  run: {
                    id,
                    key: `${page}:${id}`,
                    offset: signed.offset,
                    length: signed.length,
                    total: signed.total,
                    ...(first.has(id) ? {} : { url: signed.url }),
                  },
                }),
          }
        : {}),
    });
    first.add(id);
  }
  for (const [id, row] of pending) {
    put(id, row);
    pending.delete(id);
  }
}

export type StateSourceReply =
  | { mode: 'runs'; plan: PhysicalGrantPlan; runs: SignedPhysicalRun[] }
  | { mode: 'rows' | 'catalog'; rows: StateSourceRow[]; digests: string[] };
