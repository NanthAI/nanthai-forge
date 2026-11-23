// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { TrialFile, TrialTask } from './hosted-trial-merge.js';

/** Bounds of one save's trial merge (flip 4, Issue 853fcde3): peers merged against, shared files,
 * bytes per file and main's State manifest size. Past a bound the file or peer is left out (no
 * notice), never guessed. */
export const TRIAL_PEERS = 8;
export const TRIAL_PATHS = 24;
export const TRIAL_FILE_BYTES = 1024 * 1024;
export const TRIAL_MAIN_STATE_BYTES = 16 * 1024 * 1024;

/** Where one object's bytes are: the stored row's location fields, resolved in the planning write. */
export type TrialObject = {
  digest: string;
  size: number;
  location?: string;
  r2Key?: string;
  r2Committed?: boolean;
  storageId?: string;
  pack?: { digest: string; size: number; offset: number };
  statePhysical?: { sha256: string; size: number };
};
/** The location fields of a stored object row, as every trial or listing read takes them. */
export function trialObject(row: {
  digest: string;
  size: number;
  location?: string;
  r2Key?: string;
  r2Committed?: boolean;
  storageId?: string;
  pack?: { digest: string; size: number; offset: number };
  statePhysical?: { sha256: string; size: number };
}): TrialObject {
  return {
    digest: row.digest,
    size: row.size,
    ...(row.location ? { location: row.location } : {}),
    ...(row.r2Key ? { r2Key: row.r2Key } : {}),
    ...(row.r2Committed ? { r2Committed: true } : {}),
    ...(row.storageId ? { storageId: row.storageId } : {}),
    ...(row.pack ? { pack: row.pack } : {}),
    ...(row.statePhysical ? { statePhysical: row.statePhysical } : {}),
  };
}
export type TrialPlan = {
  laneId: string;
  head: string;
  peers: { laneId: string; head: string }[];
  tasks: TrialTask[];
  objects: TrialObject[];
  /** Source is authoritative: a sync or resolution delta can describe a draft, not the Lane base.
   * `landed`: this Lane's own head an accepted landing carried after its base (kept open since); its
   * files are the Lane's baseline for the trial, since main already holds them. */
  sources?: {
    laneId: string;
    base: TrialObject;
    head: TrialObject;
    resolved?: TrialObject;
    landed?: TrialObject;
  }[];
  /** Main's head State and the Lane's paths main changed after the Lane's base. */
  main?: { head: string; state: TrialObject; paths: string[] };
};

type Files = ReadonlyMap<string, NonNullable<TrialFile>>;
/** Binds each task's sides to the authoritative States the reader parsed (Item 3f70760d). A Lane's
 * own landed head, when given, is its baseline. Main's file goes only on the paths main changed after
 * the Lane's base (`main.paths`): elsewhere main still holds the base file, so a delta that describes
 * a draft can never read as a conflict with main ("Sync now") when no main commit touched the file. */
export function bindTrialSides(
  plan: Pick<TrialPlan, 'laneId' | 'tasks' | 'main'>,
  sources: { laneId: string; base: Files; head: Files; resolved?: Files; landed?: Files }[],
  main?: Files,
) {
  for (const source of sources)
    for (const task of plan.tasks) {
      const side =
        source.laneId === plan.laneId ? task.mine : task.peers.find(p => p.laneId === source.laneId);
      if (!side) continue;
      side.before = (source.landed ?? source.base).get(task.path) ?? null;
      side.after = source.head.get(task.path) ?? null;
      if (source.resolved) side.resolved = source.resolved.get(task.path) ?? null;
    }
  if (!main || !plan.main) return;
  const changed = new Set(plan.main.paths);
  for (const task of plan.tasks) if (changed.has(task.path)) task.main = main.get(task.path) ?? null;
}
