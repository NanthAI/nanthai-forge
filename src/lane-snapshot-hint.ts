// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { clientCacheRoot } from './root-paths.js';
import { neverIndex } from './forge-disk.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True when this checkout's Lane is already recorded as finished in the local Lane registry
 * (friction d8012963). Reads only two small JSON files so snapshot hooks never pull `zod` or
 * `lane-registry` into the CLI startup chunk graph. */
export function finishedLaneCheckout(root: string): boolean {
  if (process.env.NODE_TEST_CONTEXT && !process.env.XDG_STATE_HOME) return false;
  try {
    const marker = JSON.parse(readFileSync(join(root, '.forge', 'hosted-lane.json'), 'utf8')) as {
      selection?: { laneId?: unknown };
    };
    const laneId = marker.selection?.laneId;
    if (typeof laneId !== 'string' || !uuid.test(laneId)) return false;
    const stateHome = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
    const entry = JSON.parse(readFileSync(join(stateHome, 'forge', 'lanes', `${laneId}.json`), 'utf8')) as {
      state?: unknown;
    };
    return entry.state === 'completed' || entry.state === 'abandoned';
  } catch {
    return false;
  }
}

/** Private snapshot state of one checkout, beside it in `<root>.forge-client/snapshots`. */
export const snapshotDirectory = (root: string) => join(clientCacheRoot(root), 'snapshots');
const keptPath = (root: string) => join(snapshotDirectory(root), 'kept');
/** Whether this checkout last saw its project keep snapshots: only a hint, so a command may start
 * its walk beside the capability read and a turn end knows whether to look. The server's reply
 * and the policy check stay the authority. Light on purpose: the Stop hook reads it first. */
export function snapshotsKept(root: string) {
  try {
    return statSync(keptPath(root)).isFile();
  } catch {
    return false;
  }
}
/** What the project's capability reply told this checkout about snapshots, kept beside `kept` so
 * a detached worker, the turn-end hook and the launch gate need no server call to know them. */
export type SnapshotSettings = { intervalMinutes: number; packs: boolean };
const defaultSettings: SnapshotSettings = { intervalMinutes: 10, packs: false };
export function snapshotSettings(root: string): SnapshotSettings {
  try {
    const value = JSON.parse(readFileSync(keptPath(root), 'utf8')) as Partial<SnapshotSettings>;
    return {
      intervalMinutes:
        typeof value.intervalMinutes === 'number' && value.intervalMinutes >= 1
          ? value.intervalMinutes
          : defaultSettings.intervalMinutes,
      packs: value.packs === true,
    };
  } catch {
    return defaultSettings;
  }
}
export function rememberSnapshotsKept(root: string | null, kept: boolean, settings?: SnapshotSettings) {
  if (!root) return;
  const text = settings ? JSON.stringify(settings) : null;
  if (snapshotsKept(root) === kept && (!kept || text === null || readKept(root) === text)) return;
  try {
    if (kept) {
      mkdirSync(snapshotDirectory(root), { recursive: true, mode: 0o700 });
      neverIndex(snapshotDirectory(root));
      writeFileSync(keptPath(root), text ?? readKept(root) ?? '');
    } else rmSync(keptPath(root), { force: true });
  } catch {
    /* A hint only. */
  }
}
const readKept = (root: string) => {
  try {
    return readFileSync(keptPath(root), 'utf8');
  } catch {
    return null;
  }
};

const timedPath = (root: string) => join(snapshotDirectory(root), 'timed');
/** Timed snapshots: the last one this checkout took in the background is older than the project's
 * interval (or there is none). Only timed snapshots count; the turn-end one and the ones before a
 * command that rewrites files neither wait for this nor move it. One stat, no parse. */
export function timedSnapshotDue(root: string, intervalMinutes: number, now = Date.now()) {
  try {
    return now - statSync(timedPath(root)).mtimeMs >= intervalMinutes * 60_000;
  } catch {
    return true;
  }
}
export function markTimedSnapshot(root: string, now = new Date()) {
  try {
    mkdirSync(snapshotDirectory(root), { recursive: true, mode: 0o700 });
    const path = timedPath(root);
    try {
      utimesSync(path, now, now);
    } catch {
      writeFileSync(path, '', { mode: 0o600 });
      utimesSync(path, now, now);
    }
  } catch {
    /* A hint only: the next background snapshot may come early. */
  }
}

export const snapshotLockPath = (root: string) => join(snapshotDirectory(root), 'lock');
/** A snapshot of this checkout is running now: its lock is fresh and the process holding it lives. */
export function snapshotLockHeld(root: string) {
  const path = snapshotLockPath(root);
  try {
    if (Date.now() - statSync(path).mtimeMs > 120_000) return false;
    const pid = Number(readFileSync(path, 'utf8'));
    // Still being written: its holder just took it.
    if (!Number.isInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as { code?: string }).code === 'EPERM';
    }
  } catch {
    return false;
  }
}
