// SPDX-License-Identifier: Apache-2.0
import { homedir } from 'node:os';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/** Machine-local index of hosted Lane checkouts this client opened: one small file per Lane,
 * written only on agent actions (no timers). Idle listing and prune read it instead of
 * walking directories or asking the server per Lane. */
export const laneRegistryEntrySchema = z.object({
  laneId: z.uuid(),
  root: z.string().min(1),
  url: z.string(),
  projectId: z.string(),
  outcome: z.string().optional(),
  openedAt: z.number(),
  lastActionAt: z.number(),
  /** Terminal state this client observed; the server read confirms before any removal. */
  state: z.enum(['completed', 'abandoned']).optional(),
  /** Owner pin as this client last saw it: prune and cache GC keep the checkout. The server decides; housekeeping refreshes it. */
  pinned: z.boolean().optional(),
  /** The Forge command this machine is running in the Lane now; a dead pid means it is stale. */
  running: z.object({ action: z.string(), pid: z.number(), since: z.number() }).nullable().optional(),
});
export type LaneRegistryEntry = z.infer<typeof laneRegistryEntrySchema>;

export function laneRegistryDirectory() {
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'forge', 'lanes');
}
/** Test processes never touch the developer's real registry unless they select one. */
const disabled = () => Boolean(process.env.NODE_TEST_CONTEXT) && !process.env.XDG_STATE_HOME;
const file = (laneId: string) => join(laneRegistryDirectory(), `${laneId}.json`);

export function readLaneEntry(laneId: string): LaneRegistryEntry | null {
  try {
    const parsed = laneRegistryEntrySchema.safeParse(JSON.parse(readFileSync(file(laneId), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
function write(entry: LaneRegistryEntry) {
  const directory = laneRegistryDirectory(),
    temporary = join(directory, `.${entry.laneId}.${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(temporary, JSON.stringify(entry));
  renameSync(temporary, file(entry.laneId));
}
/** Record or refresh a Lane checkout. Never throws: the registry is advisory. */
export function recordLane(
  input: Partial<LaneRegistryEntry> & { laneId: string },
  now = Date.now(),
): LaneRegistryEntry | null {
  if (disabled()) return null;
  try {
    const previous = readLaneEntry(input.laneId);
    const root = input.root ?? previous?.root;
    if (!root && !previous) return null;
    const entry = laneRegistryEntrySchema.parse({
      ...previous,
      ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
      root,
      url: input.url ?? previous?.url ?? '',
      projectId: input.projectId ?? previous?.projectId ?? '',
      openedAt: previous?.openedAt ?? now,
      lastActionAt: input.lastActionAt ?? now,
    });
    write(entry);
    return entry;
  } catch {
    return null;
  }
}
export function forgetLane(laneId: string) {
  rmSync(file(laneId), { force: true });
}
export function listLanes(): LaneRegistryEntry[] {
  if (disabled()) return [];
  let names: string[];
  try {
    names = readdirSync(laneRegistryDirectory());
  } catch {
    return [];
  }
  return names
    .filter(name => /^[0-9a-f-]{36}\.json$/.test(name))
    .flatMap(name => readLaneEntry(name.slice(0, -5)) ?? []);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};
/** Mark a Forge command as running in the Lane: one local file write, no network, no timer. */
export function beginLaneCommand(laneId: string, action: string, now = Date.now()) {
  recordLane({ laneId, running: { action, pid: process.pid, since: now } }, now);
}
/** Clear only this process's marker, so a concurrent command's own marker survives. */
export function endLaneCommand(laneId: string, now = Date.now()) {
  if (readLaneEntry(laneId)?.running?.pid === process.pid) recordLane({ laneId, running: null }, now);
}
/** Run `work` with the Lane marked as running; the marker is removed even when `work` throws. */
export async function withLaneCommand<T>(laneId: string | undefined, action: string, work: () => Promise<T>) {
  if (!laneId) return work();
  beginLaneCommand(laneId, action);
  try {
    return await work();
  } finally {
    endLaneCommand(laneId);
  }
}
/** Liveness from this machine's registry: last command touching the Lane and whether one runs now. */
export function laneLiveness(laneId: string) {
  const entry = readLaneEntry(laneId);
  if (!entry) return null;
  const running = entry.running && alive(entry.running.pid) ? entry.running : null;
  return {
    lastActionAt: new Date(entry.lastActionAt).toISOString(),
    running: running
      ? { action: running.action, pid: running.pid, since: new Date(running.since).toISOString() }
      : null,
  };
}
