// SPDX-License-Identifier: Apache-2.0
'use node';
import type { Delta } from './projectSourceReturnDelta';
import type { ActionCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { invariant } from '../src/errors';
import { CLI_UPGRADE_MESSAGE } from './projectOwnerDerived';
import { firstIndexBatch, type IndexEntry, type IndexMetadata } from '../src/work-hosted-index';
import type { WorkData } from '../src/work-types';
import type { sourceManifestSchema } from '../src/work-archive-metadata';
import type { z } from 'zod';
import type { FunctionArgs } from 'convex/server';
type Final = FunctionArgs<typeof internal.projectWork.returnSource>;
type Snapshot = {
  data: WorkData;
  manifest: z.infer<typeof sourceManifestSchema>;
  backup: Doc<'projectBackups'>;
  output?: IndexEntry[];
  omit?: string[];
};
export type Cursor = {
  protocol?: 3;
  snapshot: Snapshot;
  snapshotRef?: import('./projectSourceReturnMetadata').ReturnRef;
  metadataOnly?: boolean;
  final: Final;
  generationId?: Id<'projectWorkGenerations'>;
  phase: 'done';
  diffstats?: { records: IndexEntry[] };
  parents: [string, string[]][];
  pending: string[];
  heads: string[];
  full?: boolean;
  copy?: { cursor: string | null };
  offset?: number;
  metadata?: IndexMetadata;
  rows: IndexEntry[];
  delta?: Delta;
  accounting?: ReturnAccounting;
};
/** Per-push storage reads (bytes), durable steps and action invocations so far. */
export type ReturnAccounting = {
  storageReads: number;
  storageBytes: number;
  steps: number;
  invocations: number;
};
// Internal transaction and scheduling budgets; retained Work has no item ceiling.
// Current snapshots/output are stored once in private database pages.
export const RETURN_BUDGET = {
  states: 16,
  sourceBytes: 2 * 1024 * 1024,
  rows: 1000,
  rowBytes: 900000,
  commitMs: 1000,
  actionMs: 30000,
  actionSteps: 1000,
};
export type StepUse = { states: number; sourceBytes: number; rows: number; rowBytes: number };
const unused: StepUse = { states: 0, sourceBytes: 0, rows: 0, rowBytes: 0 };

/** Drain validated rows, copying retained index rows only for large deltas. */
export async function advance(ctx: ActionCtx, c: Cursor, _reader?: unknown, used: StepUse = unused) {
  invariant(c.phase === 'done', 'CLI_UPGRADE_REQUIRED', CLI_UPGRADE_MESSAGE);
  const room = { rows: RETURN_BUDGET.rows - used.rows, bytes: RETURN_BUDGET.rowBytes - used.rowBytes };
  if (!c.rows.length && (c.offset ?? 0) < (c.snapshot.output?.length ?? 0)) {
    let entries =
      room.rows > 0
        ? firstIndexBatch(c.snapshot.output!.slice(c.offset, (c.offset ?? 0) + room.rows), room)
        : [];
    if (used.rows && Buffer.byteLength(JSON.stringify(entries)) > room.bytes) entries = [];
    c.offset = (c.offset ?? 0) + entries.length;
    return {
      entries,
      sourceBytes: 0,
      states: 0,
      derivedReadFailures: 0,
      last: !c.copy && c.offset >= c.snapshot.output!.length,
    };
  } else if (!c.rows.length && c.copy) {
    invariant(c.generationId, 'WORK_STALE', 'The original display generation is unavailable.');
    const page: { entries: IndexEntry[]; cursor: string | null } | null = await ctx.runQuery(
      internal.projectWorkIndexStore.snapshotEntries,
      {
        projectId: c.final.projectId,
        owner: c.final.owner,
        generationId: c.generationId,
        revision: c.final.expectedRevision,
        cursor: c.copy.cursor,
      },
    );
    invariant(page, 'WORK_STALE', 'Hosted index changed during owner display staging.');
    const omit = new Set(c.snapshot.omit);
    c.rows = page.entries.filter(r => !omit.has(JSON.stringify([r.collection, r.key])));
    c.copy.cursor = page.cursor;
    if (page.cursor === null) delete c.copy;
  }
  let entries = room.rows > 0 ? firstIndexBatch(c.rows, room) : [];
  if (used.rows && Buffer.byteLength(JSON.stringify(entries)) > room.bytes) entries = [];
  c.rows.splice(0, entries.length);
  return {
    entries,
    sourceBytes: 0,
    states: 0,
    derivedReadFailures: 0,
    last: !c.rows.length && !c.copy && (c.offset ?? 0) >= (c.snapshot.output?.length ?? 0),
  };
}
