// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { laneRegistryDirectory } from './lane-registry.js';
import { presenceNotice, type PresenceLane } from './hosted-presence.js';

/** What this machine already showed for a Lane: no server write per delivery. Two machines on one
 * Lane may each show a notice once; that is accepted. */
const stateSchema = z.object({ since: z.number(), seen: z.array(z.string()).max(200) });
const SEEN = 200;
const disabled = () => Boolean(process.env.NODE_TEST_CONTEXT) && !process.env.XDG_STATE_HOME;
const file = (laneId: string) => join(dirname(laneRegistryDirectory()), 'presence', `${laneId}.json`);

export function readPresenceState(laneId: string): z.infer<typeof stateSchema> | null {
  if (disabled()) return null;
  try {
    const parsed = stateSchema.safeParse(JSON.parse(readFileSync(file(laneId), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The overlap read's presence argument: everything on the first read, then Lanes active since. */
export function presenceSince(laneId: string): { since?: number } {
  const state = readPresenceState(laneId);
  return state ? { since: state.since } : {};
}

export const presenceLaneSchema = z.looseObject({
  laneId: z.string(),
  intentId: z.string(),
  goal: z.string(),
  actor: z.string().optional(),
  yours: z.boolean(),
  at: z.number(),
  paths: z.array(z.string()),
  pathCount: z.number(),
  why: z.array(z.enum(['issue', 'paths', 'goal'])),
});
export const presenceSchema = z.looseObject({
  at: z.number(),
  lanes: z.array(presenceLaneSchema),
  more: z.number(),
  coverage: z.string(),
});

/** Lanes not shown before on this machine, rendered (≤3 lines, ≤240 chars each). Never throws. */
export function presenceDelivery(laneId: string, presence: z.infer<typeof presenceSchema>) {
  const state = readPresenceState(laneId);
  const seen = new Set(state?.seen ?? []);
  const fresh = presence.lanes.filter(lane => !seen.has(lane.laneId));
  if (!disabled())
    try {
      const next = {
        since: presence.at,
        seen: [...(state?.seen ?? []), ...fresh.map(lane => lane.laneId)].slice(-SEEN),
      };
      const target = file(laneId),
        temporary = join(dirname(target), `.${laneId}.${randomUUID()}`);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify(next));
      renameSync(temporary, target);
    } catch {
      /* Advisory: a lost cursor only repeats a notice. */
    }
  if (!fresh.length) return undefined;
  return {
    notices: fresh.map(lane => presenceNotice(lane as PresenceLane, presence.at)),
    more: presence.more,
    coverage: presence.coverage,
  };
}
export type PresenceDelivery = NonNullable<ReturnType<typeof presenceDelivery>>;
