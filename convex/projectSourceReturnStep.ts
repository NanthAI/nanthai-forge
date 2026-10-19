// SPDX-License-Identifier: Apache-2.0
'use node';
import { ancestryEntries, stateParentEntries, type Delta } from './projectSourceReturnDelta';
import { sourceTreeEntries } from '../src/source-tree-index';
import { advanceDiffstats, type DiffstatProgress } from './projectDiffstatProgress';
import type { ActionCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { invariant } from '../src/errors';
import { exchangeObjectReader } from './projectExchangeReader';
import { parseNativeState } from '../src/native-source';
import { archiveChannels } from '../src/work-archive-metadata';
import {
  materializeWork,
  firstIndexBatch,
  indexedRecord,
  type IndexEntry,
  type IndexMetadata,
} from '../src/work-hosted-index';
import { hostedAncestry } from '../src/work-hosted-ancestry';
import { viewContributors } from '../src/view-read-model';
import { viewIndexEntries } from '../src/view-hosted-index';
import { reviewPaths } from '../src/native-source-review';
import type { WorkData } from '../src/work-types';
import type { sourceManifestSchema } from '../src/work-archive-metadata';
import type { z } from 'zod';
import type { FunctionArgs } from 'convex/server';
type Final = FunctionArgs<typeof internal.projectWork.returnSource>;
type Snapshot = {
  data: WorkData;
  manifest: z.infer<typeof sourceManifestSchema>;
  backup: Doc<'projectBackups'>;
};
export type Cursor = {
  snapshot: Snapshot;
  snapshotRef?: Id<'_storage'>;
  final: Final;
  generationId: Id<'projectWorkGenerations'>;
  phase: 'parents' | 'base' | 'diffstats' | 'ancestry' | 'views' | 'done';
  diffstats?: DiffstatProgress;
  parents: [string, string[]][];
  pending: string[];
  heads: string[];
  head: number;
  view: number;
  states: [string, ReturnType<typeof parseNativeState>['files']][];
  paths?: string[];
  positions: [string, number][];
  metadata?: IndexMetadata;
  rows: IndexEntry[];
  delta?: Delta;
  phaseStarted?: number;
  accounting?: ReturnAccounting;
};
/** Per-push storage reads (bytes), durable steps and action invocations so far. */
export type ReturnAccounting = {
  storageReads: number;
  storageBytes: number;
  steps: number;
  invocations: number;
};
const derived = ['viewDetails', 'viewFiles', 'laneViews', 'viewAcceptances'];
// These are internal work budgets, never source capacity limits. The cursor is
// in file storage, not a database document or RPC argument/return value.
// states/sourceBytes/rows/rowBytes bound one durable step (one commit). One
// action invocation runs steps for up to actionMs or actionSteps: each
// invocation rereads the cursor and snapshot unless this worker memoized them.
export const RETURN_BUDGET = {
  states: 16,
  sourceBytes: 2 * 1024 * 1024,
  rows: 100,
  rowBytes: 500000,
  commitMs: 1000,
  actionMs: 30000,
  actionSteps: 1000,
};
export type StepUse = { states: number; sourceBytes: number; rows: number; rowBytes: number };
const unused: StepUse = { states: 0, sourceBytes: 0, rows: 0, rowBytes: 0 };

/** Advances within what remains of the current step's budget after `used`. */
export async function advance(
  ctx: ActionCtx,
  c: Cursor,
  reader = exchangeObjectReader(ctx, false, 0),
  used: StepUse = unused,
) {
  const { data, manifest, backup } = c.snapshot,
    pins = new Map(manifest.files.map(p => [p.sha256, p]));
  const fresh = !used.states && !used.sourceBytes && !used.rows;
  let sourceBytes = 0,
    states = 0,
    derivedReadFailures = 0;
  const read = async (head: string) => {
    states++;
    const pin = pins.get(head);
    invariant(pin, 'SOURCE_UNAVAILABLE', 'A retained State is unavailable.');
    sourceBytes += pin.size;
    return parseNativeState((await reader.read(backup.projectId, c.final.owner, [pin]))[0]!);
  };
  // A fresh step admits its first State; later States must fit what remains.
  const fits = (head: string) =>
    (fresh && !states) ||
    (used.states + states < RETURN_BUDGET.states &&
      used.sourceBytes + sourceBytes + (pins.get(head)?.size ?? 0) <= RETURN_BUDGET.sourceBytes);
  const drain = async (save: (head: string, state: ReturnType<typeof parseNativeState>) => void) => {
    while (c.pending.length && used.states + states < RETURN_BUDGET.states) {
      const head = c.pending[0]!,
        pin = pins.get(head);
      if (pin && (states || !fresh) && used.sourceBytes + sourceBytes + pin.size > RETURN_BUDGET.sourceBytes)
        break;
      c.pending.shift();
      try {
        save(head, await read(head));
      } catch {
        derivedReadFailures++;
      }
    }
  };
  if (!c.rows.length) {
    if (c.phase === 'parents') {
      const parents = new Map(c.parents),
        queued = new Set([...parents.keys(), ...c.pending, ...(c.delta?.stopParents ?? [])]);
      await drain((head, state) => {
        parents.set(head, state.parents);
        if (c.delta) c.rows.push(...stateParentEntries(head, state.parents));
        if (
          head === manifest.head ||
          archiveChannels(manifest, data).some(channel => channel.name === 'main' && channel.head === head) ||
          (data.hostedChannelMoves ?? []).filter(channel => channel.channel === 'main').at(-1)?.head === head
        )
          c.rows.push(...sourceTreeEntries(head, state.files));
        for (const parent of state.parents)
          if (!queued.has(parent)) {
            queued.add(parent);
            c.pending.push(parent);
          }
      });
      c.parents = [...parents];
      if (!c.pending.length) c.phase = 'base';
    } else if (c.phase === 'base') {
      if (c.delta) {
        c.phase = 'diffstats';
      } else {
        const projection = materializeWork(data, manifest, [], 'objects', new Map(c.parents), true);
        c.metadata = projection.metadata;
        c.rows = projection.entries.filter(row => row.collection !== 'lanes' && row.collection !== 'views');
        for (const name of derived) c.metadata.counts[name] = 0;
        c.diffstats = {
          records: projection.entries.filter(row => row.collection === 'lanes' || row.collection === 'views'),
          index: 0,
          cache: [],
        };
        c.phase = 'diffstats';
      }
    } else if (c.phase === 'diffstats') {
      if (!c.diffstats) c.phase = 'ancestry';
      else {
        const step = await advanceDiffstats(
          ctx,
          c.diffstats,
          backup,
          c.generationId,
          c.final.owner,
          pins,
          read,
          {
            states: RETURN_BUDGET.states - used.states - states,
            sourceBytes: RETURN_BUDGET.sourceBytes - used.sourceBytes - sourceBytes,
            fresh: fresh && !states && !sourceBytes,
          },
        );
        c.rows = step.entries;
        sourceBytes += step.sourceBytes;
        derivedReadFailures += step.failures;
        if (!c.delta && c.diffstats.cache.length) c.metadata!.counts.diffstats = c.diffstats.cache.length;
        if (step.done) {
          delete c.diffstats;
          c.phase = 'ancestry';
        }
      }
    } else if (c.phase === 'ancestry') {
      const head = c.heads[c.head++];
      if (head) {
        if (c.delta) c.rows.push(...ancestryEntries(head, new Map(c.parents)));
        else {
          const ancestry = hostedAncestry(data, new Map(c.parents), { head });
          for (const [collection, values] of [
            ['sourceAncestry', ancestry.pairs],
            ['sourceAncestryHeads', ancestry.complete],
          ] as const)
            for (const value of values) {
              const position = c.metadata!.counts[collection] ?? 0;
              c.metadata!.counts[collection] = position + 1;
              c.rows.push(
                ...indexedRecord(
                  collection,
                  'key' in value ? value.key : value.head,
                  collection === 'sourceAncestry' ? value.head : '',
                  position,
                  value,
                ),
              );
            }
        }
      } else {
        c.phase = 'views';
        c.parents = [];
      }
    } else if (c.phase === 'views') {
      const viewIndex = c.delta ? c.delta.views[c.view] : c.view;
      const view = viewIndex === undefined ? undefined : data.views[viewIndex];
      if (!view) c.phase = 'done';
      else {
        try {
          if (!c.paths) {
            if (view.head && view.status !== 'conflict') {
              const idle = { entries: [], sourceBytes, states, derivedReadFailures, last: false };
              if (!c.states.length) {
                if (!fits(view.base)) return idle;
                c.states = [[view.base, (await read(view.base)).files]];
                return { ...idle, sourceBytes, states };
              }
              if (!fits(view.head)) return idle;
              const before = { files: c.states[0]![1] },
                after = await read(view.head);
              c.paths = reviewPaths(before.files, after.files)
                .filter(f => f.status !== 'unchanged')
                .map(f => f.path);
              const paths = new Set(c.paths);
              c.states = [
                [view.base, before.files.filter(f => paths.has(f.path))],
                [view.head, after.files.filter(f => paths.has(f.path))],
              ];
              const known = new Set(c.states.map(([head]) => head));
              c.pending = [
                ...new Set(
                  viewContributors(data, view).flatMap(v => [
                    v.head,
                    ...v.saves.flatMap(({ save }) => [save.parent, save.head]),
                  ]),
                ),
              ].filter(h => !known.has(h));
            } else c.paths = [];
          } else {
            const paths = new Set(c.paths);
            await drain((head, state) => c.states.push([head, state.files.filter(f => paths.has(f.path))]));
          }
        } catch {
          // Optional provenance remains explicitly unavailable, as in R3.
          // The batch/final mutation still rechecks current owner authority.
          c.states = [];
          c.pending = [];
          c.paths = [];
          derivedReadFailures++;
        }
        if (!c.pending.length) {
          const positions = new Map(c.positions);
          c.rows = viewIndexEntries(data, new Map(c.states), { index: viewIndex!, positions });
          if (c.delta) {
            let cursor: string | null = null;
            const keys = new Set(c.rows.filter(r => r.collection === 'viewFiles').map(r => r.key));
            do {
              const page: { entries: IndexEntry[]; cursor: string | null } = await ctx.runQuery(
                internal.projectWorkIndexStore.viewFiles,
                {
                  projectId: backup.projectId,
                  owner: c.final.owner,
                  generationId: c.generationId,
                  viewId: view.id,
                  cursor,
                },
              );
              for (const old of page.entries)
                if (!keys.has(old.key)) {
                  c.delta.removed.push({ collection: old.collection, key: old.key });
                  c.delta.readBytes += Buffer.byteLength(JSON.stringify(old)) + 2048;
                  c.metadata!.counts.viewFiles!--;
                }
              cursor = page.cursor;
            } while (cursor !== null);
          }
          for (const name of c.delta ? [] : derived)
            c.metadata!.counts[name]! += c.rows.filter(r => r.collection === name).length;
          c.positions = [...positions];
          c.view++;
          c.states = [];
          delete c.paths;
        }
      }
    }
  }
  const room = { rows: RETURN_BUDGET.rows - used.rows, bytes: RETURN_BUDGET.rowBytes - used.rowBytes };
  let entries = room.rows > 0 ? firstIndexBatch(c.rows, room) : [];
  // Only a step's first rows may exceed its byte budget (one oversized row).
  if (used.rows && Buffer.byteLength(JSON.stringify(entries)) > room.bytes) entries = [];
  c.rows.splice(0, entries.length);
  return { entries, sourceBytes, states, derivedReadFailures, last: c.phase === 'done' && !c.rows.length };
}
