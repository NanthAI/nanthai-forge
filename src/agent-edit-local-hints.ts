// SPDX-License-Identifier: Apache-2.0
// Forge teaches its working rules at the moment they matter (Item 6b7d5a79): the first-write hook says when an
// edit lands in the project's main copy, during a live landing, or after a long unsaved stretch. Local reads only
// (a marker stat, the machine's Lane registry file and one small cache entry): no server call, nothing at idle.
// Light module: the hook imports it. Node builtins and the hook's own light modules only.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { PeersCache } from './agent-peers-cache.js';
import { readEditMarkerIdentity, type EditTarget } from './agent-edit-target.js';
import { shellQuote } from './shell-quote.js';

/** The shipped checkpoint nudge (agent-parallel-defaults checkpointNudgeMinutes); the hook reads no settings. */
export const UNSAVED_HINT_MINUTES = 30;
/** A recorded landing older than this was settled without this machine seeing it; it is not live. */
const LIVE_LANDING_MS = 6 * 3_600_000;
const short = (id: string) => id.slice(0, 8);

/** The project folder (a `nforge clone`, `.forge/hosted-main.json`) that holds `path`, unless a Lane lies between. */
export function cloneRootOf(path: string): { root: string; projectId?: string } | null {
  for (let root = dirname(path); ; root = dirname(root)) {
    if (existsSync(join(root, '.forge', 'hosted-lane.json'))) return null;
    const marker = join(root, '.forge', 'hosted-main.json');
    if (existsSync(marker)) {
      try {
        const projectId = readEditMarkerIdentity(marker)?.selection?.projectId;
        return { root, ...(typeof projectId === 'string' ? { projectId } : {}) };
      } catch {
        return { root };
      }
    }
    if (dirname(root) === root) return null;
  }
}

/** Once per session and project folder: an edit there is not saved by Forge. */
export function cloneRootHint(clone: { root: string }, session: string, cache = new PeersCache(clone.root)) {
  const key = `clone-root-edit-v1:${session}`;
  if (cache.read(key)) return '';
  cache.write(key, { shown: true });
  return `Forge: ${clone.root} is the project's copy of main, not a Lane: Forge never saves or lands edits here. Start a Lane and edit in the folder it prints: nforge agent ${shellQuote(clone.root)} start '{"outcome":"what you will change"}' (or {"planningItemId":"ITEM_ID"}).`;
}

/** The landing this machine submitted for the Lane and has not seen settle (lane-registry `landing`). */
function liveLanding(laneId: string, now: number): string | undefined {
  try {
    const directory = join(
      process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
      'forge',
      'lanes',
    );
    const entry = JSON.parse(readFileSync(join(directory, `${laneId}.json`), 'utf8')) as {
      state?: unknown;
      landing?: { operationId?: unknown; at?: unknown } | null;
    };
    const landing = entry.landing;
    if (entry.state || !landing || typeof landing.operationId !== 'string' || typeof landing.at !== 'number')
      return undefined;
    return now - landing.at < LIVE_LANDING_MS ? landing.operationId : undefined;
  } catch {
    return undefined;
  }
}

/** Lane hints on a write: a live landing (every time: an edit now is not in it), then unsaved work older than the
 * nudge (once per stretch, again every nudge interval). The stretch starts at the first write after the last save.
 * Writes under `.forge/` (scratch, land messages) are never saved or landed, so they get no hint. */
export function laneEditHints(target: EditTarget, now = Date.now(), cache = new PeersCache(target.root)) {
  const hints: string[] = [];
  if (/^\.forge(?:\/|$)/.test(target.path.replaceAll('\\', '/'))) return hints;
  const root = shellQuote(target.root);
  const landing = liveLanding(target.laneId, now);
  if (landing)
    hints.push(
      `Forge: Lane ${short(target.laneId)} has a landing in flight; this edit is not in it. Wait for it: nforge agent ${root} wait '{"operationIds":["${landing}"]}', or withdraw it first: nforge agent ${root} land --withdraw '{}'.`,
    );
  let savedAt: number;
  try {
    savedAt = statSync(join(target.root, '.forge', 'hosted-lane.json')).mtimeMs;
  } catch {
    return hints;
  }
  const key = `unsaved-stretch-v1:${target.laneId}:${Math.floor(savedAt)}`;
  const stretch = cache.read<{ since: number; nudgedAt?: number }>(key);
  if (!stretch) cache.write(key, { since: now });
  else if (!landing) {
    const minutes = Math.floor((now - stretch.since) / 60_000);
    const due = minutes >= UNSAVED_HINT_MINUTES;
    const quiet = stretch.nudgedAt !== undefined && now - stretch.nudgedAt < UNSAVED_HINT_MINUTES * 60_000;
    if (due && !quiet) {
      cache.write(key, { since: stretch.since, nudgedAt: now });
      hints.push(
        `Forge: unsaved edits for ${minutes} min in Lane ${short(target.laneId)}; save now: nforge agent ${root} save '{"message":"checkpoint"}'`,
      );
    }
  }
  return hints;
}
