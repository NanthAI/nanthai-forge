// SPDX-License-Identifier: Apache-2.0
import type { TrialTask } from './hosted-trial-merge.js';

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
export type TrialPlan = {
  laneId: string;
  head: string;
  peers: { laneId: string; head: string }[];
  tasks: TrialTask[];
  objects: TrialObject[];
  /** Source is authoritative: a sync or resolution delta can describe a draft, not the Lane base. */
  sources?: { laneId: string; base: TrialObject; head: TrialObject }[];
  /** Main's head State and the Lane's paths main changed after the Lane's base. */
  main?: { head: string; state: TrialObject; paths: string[] };
};
