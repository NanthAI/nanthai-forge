// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type { ActionCtx } from './_generated/server';
import { invariant } from '../src/errors';
import { snapshotCount, snapshotFence, snapshotRecord } from '../src/public-snapshot-contract';
import { type DirectoryRow, directoryAuditPage } from './publicDirectorySource';
import { publishSnapshot } from './publicSnapshotStorage';
import { readR2Object } from './r2Operations';
import type { R2Config } from './r2';

// A private, frozen copy of the previous packs' row set. Do not reconstruct it by reading a mixture
// of old and half-written pages after a failed ranking update. Only commit it after all serving keys.
const address = { key: 'internal/public-directory/v1/inputs.json', limit: 32 * 1024 * 1024 };
const dayMs = 86_400_000;
type Job = Pick<Doc<'publicSnapshotJobs'>, '_id' | 'serial' | 'generation'>;
type Input = { rows: DirectoryRow[]; day: number; auditCursor: string | null; auditAfter: string | null };
const byId = (a: DirectoryRow, b: DirectoryRow) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

async function previousInput(config: R2Config): Promise<Input | null> {
  const object = await readR2Object(config, address.key, address.limit);
  if (!object) return null;
  const stored = snapshotRecord(JSON.parse(new TextDecoder().decode(object.bytes)));
  invariant(
    stored &&
      snapshotFence(stored)?.state === 'public' &&
      Array.isArray(stored.rows) &&
      stored.rows.every(
        row => typeof row?.id === 'string' && Array.isArray(row.days) && row.days.length === 7,
      ) &&
      snapshotCount(stored.day) &&
      (stored.auditCursor === null || typeof stored.auditCursor === 'string') &&
      (stored.auditAfter === null || typeof stored.auditAfter === 'string'),
    'SOURCE_CHANGED',
    'The directory checkpoint is invalid.',
  );
  return {
    rows: stored.rows,
    day: stored.day,
    auditCursor: stored.auditCursor,
    auditAfter: stored.auditAfter,
  };
}

function roll(row: DirectoryRow, elapsed: number) {
  if (!elapsed) return row;
  const days = Array.from({ length: 7 }, (_, i) => row.days[i + elapsed] ?? 0);
  return { ...row, days, landings: days.reduce((total, n) => total + n, 0) };
}

export async function readDirectoryInput(
  ctx: ActionCtx,
  config: R2Config,
  job: Job,
  now: number,
): Promise<Input> {
  const previous = await previousInput(config);
  const day = Math.floor(now / dayMs);
  const rows = new Map(
    (previous?.rows ?? []).map(row => [row.id, roll(row, Math.max(day - previous!.day, 0))]),
  );
  let auditAfter: string | null = null;
  let auditCursor: string | null = null;
  if (previous) {
    // A small, rotating two-sided drift check: discover missed listings and recheck old published IDs.
    // It runs only on change, spends at most two 32-row queries, and never scans all Convex rows again.
    const at = previous.auditAfter;
    const index = at === null ? 0 : previous.rows.findIndex(row => row.id > at);
    const known = previous.rows.slice(Math.max(0, index), Math.max(0, index) + directoryAuditPage);
    const [listed, checked] = await Promise.all([
      ctx.runQuery(internal.publicDirectorySource.readSlice, {
        now,
        cursor: previous.auditCursor,
        audit: true,
      }),
      ctx.runQuery(internal.publicDirectorySource.checkPublished, { now, ids: known.map(row => row.id) }),
    ]);
    for (const row of listed.projects) rows.set(row.id, row);
    for (const { projectId, row } of checked) {
      if (row) rows.set(row.id, row);
      else rows.delete(projectId);
    }
    auditCursor = listed.cursor;
    auditAfter = known.at(-1)?.id ?? null;
  } else {
    let cursor: string | null = null;
    do {
      const page: { projects: DirectoryRow[]; cursor: string | null } = await ctx.runQuery(
        internal.publicDirectorySource.readSlice,
        { now, cursor },
      );
      for (const row of page.projects) rows.set(row.id, row);
      cursor = page.cursor;
    } while (cursor !== null);
  }
  // Apply signed-off deltas last; a removed project has a marker even when its listing row was purged.
  let cursor: string | null = null;
  do {
    const page: {
      changes: { projectId: Id<'hostedProjects'>; row: DirectoryRow | null }[];
      cursor: string | null;
    } = await ctx.runQuery(internal.publicDirectorySource.changedSlice, {
      now,
      serial: job.serial,
      cursor,
    });
    for (const { projectId, row } of page.changes) {
      if (row) rows.set(row.id, row);
      else rows.delete(projectId);
    }
    cursor = page.cursor;
  } while (cursor !== null);
  return { rows: [...rows.values()].sort(byId), day, auditCursor, auditAfter };
}

export async function commitDirectoryInput(
  ctx: ActionCtx,
  config: R2Config,
  job: Job,
  input: Input,
  asOf: number,
) {
  const identity = { id: job._id, serial: job.serial };
  const state = await publishSnapshot(config, address, async () =>
    (await ctx.runQuery(internal.publicSnapshotJobs.current, identity))
      ? { state: 'public', generation: job.generation, asOf, data: input }
      : null,
  );
  if (state !== 'written' && state !== 'unchanged') return false;
  let status: 'stale' | 'done' | 'more';
  do {
    status = await ctx.runMutation(internal.publicDirectorySource.consumeChanges, identity);
  } while (status === 'more');
  return status === 'done';
}
