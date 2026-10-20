// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { IndexEntry } from '../src/work-hosted-index';
import type { parseNativeState } from '../src/native-source';
import { reviewPaths } from '../src/native-source-review';
import { internal } from './_generated/api';
import { invariant } from '../src/errors';
import { compareFiles, type Pin, type Stats } from './projectDiffstatProjection';
import { noteStorageRead } from './storageMeter';
type Files = ReturnType<typeof parseNativeState>['files'];
type Pair = { before?: Pin; after?: Pin };
export type DiffstatProgress = {
  records: IndexEntry[];
  index: number;
  cache: [string, Stats][];
  pending?: { before?: Files; files?: Pair[]; offset: number; add: number; del: number; exact: boolean };
};
const LOOKUP_KEYS = 16,
  COMPARE_FILES = 16;

/** Many records per durable return step, within the caller's remaining State and
 * byte budget; a partly compared pair resumes from its saved offset. Cached
 * immutable pairs need no source reads, including within this return. */
export async function advanceDiffstats(
  ctx: ActionCtx,
  cursor: DiffstatProgress,
  backup: Doc<'projectBackups'>,
  generationId: Id<'projectWorkGenerations'>,
  owner: string,
  pins: ReadonlyMap<string, Pin>,
  readState: (head: string) => Promise<ReturnType<typeof parseNativeState>>,
  budget: { states: number; sourceBytes: number; fresh: boolean },
  supplied?: [string, Stats][],
) {
  const result = { entries: [] as IndexEntry[], sourceBytes: 0, failures: 0, done: false };
  let states = 0,
    stateBytes = 0;
  const known = new Map<string, Stats | null>();
  // A fresh step admits its first unit of work, so every step makes progress.
  const room = (bytes: number, state: boolean) =>
    (budget.fresh && !states && !result.sourceBytes) ||
    ((!state || states < budget.states) && stateBytes + result.sourceBytes + bytes <= budget.sourceBytes);
  const read = async (head: string) => {
    states++;
    stateBytes += pins.get(head)?.size ?? 0;
    return (await readState(head)).files;
  };
  const lookup = async (key: string) => {
    if (!known.has(key)) {
      const keys = [key];
      for (let i = cursor.index + 1; i < cursor.records.length && keys.length < LOOKUP_KEYS; i++) {
        const next = JSON.parse(cursor.records[i]!.value) as { base: string; head?: string };
        const pair = next.head ? `${next.base}:${next.head}` : '';
        if (pair && !keys.includes(pair) && !known.has(pair) && !cursor.cache.some(([k]) => k === pair))
          keys.push(pair);
      }
      const rows = await ctx.runQuery(internal.projectWorkIndexStore.lookups, {
        projectId: backup.projectId,
        owner,
        generationId,
        keys: keys.map(key => ({ collection: 'diffstats', key })),
      });
      keys.forEach((k, i) => known.set(k, rows[i] ? (JSON.parse(rows[i]!.value) as Stats) : null));
    }
    return known.get(key) ?? undefined;
  };
  while (true) {
    const row = cursor.records[cursor.index];
    if (!row) {
      result.done = true;
      return result;
    }
    const value = JSON.parse(row.value) as { base: string; head?: string; status?: string };
    const next = () => {
      cursor.index++;
      delete cursor.pending;
    };
    if (!value.head || value.status === 'conflict') {
      result.entries.push(row);
      next();
      continue;
    }
    const key = `${value.base}:${value.head}`;
    const emit = (stats: Stats) => {
      result.entries.push({ ...row, value: JSON.stringify({ ...value, changes: stats }) });
      if (!cursor.cache.some(([cached]) => cached === key)) {
        result.entries.push({
          collection: 'diffstats',
          key,
          parent: '',
          position: cursor.cache.length,
          value: JSON.stringify(stats),
        });
        cursor.cache.push([key, stats]);
      }
      next();
    };
    try {
      if (!cursor.pending) {
        const stats =
          supplied?.find(([cached]) => cached === key)?.[1] ??
          cursor.cache.find(([cached]) => cached === key)?.[1] ??
          (await lookup(key));
        if (stats) {
          emit(stats);
          continue;
        }
        cursor.pending = { offset: 0, add: 0, del: 0, exact: true };
      }
      const pending = cursor.pending;
      if (!pending.before && !pending.files) {
        if (!room(pins.get(value.base)?.size ?? 0, true)) return result;
        pending.before = await read(value.base);
      }
      if (!pending.files) {
        if (!room(pins.get(value.head)?.size ?? 0, true)) return result;
        const after = await read(value.head);
        const pin = (hash: string) => {
          const selected = pins.get(hash);
          invariant(selected, 'SOURCE_UNAVAILABLE', 'Diffstat source is unavailable.');
          return { sha256: selected.sha256, size: selected.size };
        };
        pending.files = reviewPaths(pending.before!, after)
          .filter(file => file.status !== 'unchanged')
          .map(file => ({
            ...(file.before ? { before: pin(file.before.blob) } : {}),
            ...(file.after ? { after: pin(file.after.blob) } : {}),
          }));
        delete pending.before;
      }
      while (pending.offset < pending.files.length) {
        const files: Pair[] = [];
        let bytes = 0;
        while (pending.offset + files.length < pending.files.length && files.length < COMPARE_FILES) {
          const file = pending.files[pending.offset + files.length]!;
          const size =
            (file.before?.size ?? 0) > 1024 * 1024 || (file.after?.size ?? 0) > 1024 * 1024
              ? 0
              : (file.before?.size ?? 0) + (file.after?.size ?? 0);
          if (!room(bytes + size, false) && (files.length || !budget.fresh || states || result.sourceBytes))
            break;
          files.push(file);
          bytes += size;
        }
        if (!files.length) return result;
        const totals = await ctx.runAction(compareFiles, {
          projectId: backup.projectId,
          actor: owner,
          files,
        });
        noteStorageRead(ctx, totals.storageBytes ?? 0, totals.storageReads ?? 0);
        pending.offset += files.length;
        result.sourceBytes += bytes;
        pending.add += totals.add;
        pending.del += totals.del;
        pending.exact &&= totals.exact;
        if (pending.offset < pending.files.length) return result;
      }
      emit({
        files: pending.files.length,
        ...(pending.exact ? { add: pending.add, del: pending.del } : {}),
      });
    } catch {
      // Optional counts remain unknown. Publication still checks current authority.
      result.failures++;
      result.entries.push(row);
      next();
    }
  }
}
