// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Loose ends actions (Item fc1831eb) over the existing mutations, with a result per row. Setting Lanes aside and
// bringing them back (Undo) go through the dormant sweep, projectHostedDormant:abandon, 25 Lanes per call; a Lane that
// gained a save or changed meanwhile comes back with its own skip word. Moving a project to the trash and restoring it
// go through projectLifecycle:trash and :restore, one owner call per project pinned to its revision; a project that
// changed meanwhile is refused (WORK_STALE) and left alone. Only a call that failed outright is retried, with its
// original operation id. Nothing here deletes: the trash keeps a project for 90 days.
import { ConvexError } from 'convex/values';

/** The sweep takes at most this many Lanes per call (projectHostedDormant DORMANT_BATCH). */
export const SWEEP_BATCH = 25;

export type SweepArgs = {
  authorityEpoch: number;
  abandon: string[];
  reopen?: { laneId: string; version: number }[];
  versions: true;
};
export type Sweep = (args: SweepArgs) => Promise<string>;
type SweepReply = { results: { laneId: string; result: string; version?: number }[] };

async function sweep(
  call: Sweep,
  epoch: number,
  entries: { laneId: string; version?: number }[],
  back: boolean,
) {
  const results: Record<string, string> = {};
  const versions: Record<string, number> = {};
  for (let i = 0; i < entries.length; i += SWEEP_BATCH) {
    const batch = entries.slice(i, i + SWEEP_BATCH);
    try {
      const reply = JSON.parse(
        await call({
          authorityEpoch: epoch,
          abandon: back ? [] : batch.map(entry => entry.laneId),
          ...(back
            ? { reopen: batch.map(entry => ({ laneId: entry.laneId, version: entry.version! })) }
            : {}),
          versions: true,
        }),
      ) as SweepReply;
      for (const entry of reply.results) {
        results[entry.laneId] = entry.result;
        if (entry.version !== undefined) versions[entry.laneId] = entry.version;
      }
    } catch {
      for (const entry of batch) results[entry.laneId] = 'failed';
    }
  }
  return { results, versions };
}

/** Set Lanes aside. Each one set aside returns the version its Undo pins. */
export const setAsideLanes = (call: Sweep, epoch: number, laneIds: string[]) =>
  sweep(
    call,
    epoch,
    laneIds.map(laneId => ({ laneId })),
    false,
  );

/** Undo: bring back Lanes still set aside at the version the sweep returned; one changed since is skipped. */
export const bringBackLanes = (call: Sweep, epoch: number, pins: { laneId: string; version: number }[]) =>
  sweep(call, epoch, pins, true).then(reply => reply.results);

export type LifecycleArgs = {
  projectId: string;
  operationId: string;
  expectedRevision: number;
  /** Trash only: the landing receipt the read saw (null: none); a project that landed since is refused. */
  expectedLastLanding?: string | null;
};
export type Lifecycle = (args: LifecycleArgs) => Promise<unknown>;
export type TrashResult = 'trashed' | 'changed' | 'failed';

const code = (error: unknown) =>
  error instanceof ConvexError ? (error.data as { code?: string } | undefined)?.code : undefined;

/** Move projects to the trash, one owner call each. A refusal because the project changed or landed (or is no longer
 * the reader's) is a skip, and so is a project someone else already moved (`applied: false`): its Undo is not ours.
 * Anything else failed; a retry replays the same request with its operation id, so it reconciles. */
export async function trashProjects(trash: Lifecycle, pins: LifecycleArgs[]) {
  const results: Record<string, TrashResult> = {};
  for (const pin of pins) {
    try {
      const reply = (await trash(pin)) as { applied?: boolean } | null;
      results[pin.projectId] = reply?.applied === false ? 'changed' : 'trashed';
    } catch (error) {
      results[pin.projectId] = ['WORK_STALE', 'PROJECT_UNAVAILABLE'].includes(code(error) ?? '')
        ? 'changed'
        : 'failed';
    }
  }
  return results;
}

/** Undo: restore projects this page moved to the trash, at the revision the trash wrote (one more than its pin). */
export async function restoreProjects(restore: Lifecycle, pins: LifecycleArgs[]) {
  const results: Record<string, 'restored' | 'changed' | 'failed'> = {};
  for (const pin of pins) {
    try {
      await restore(pin);
      results[pin.projectId] = 'restored';
    } catch (error) {
      results[pin.projectId] = code(error) === 'WORK_STALE' ? 'changed' : 'failed';
    }
  }
  return results;
}
