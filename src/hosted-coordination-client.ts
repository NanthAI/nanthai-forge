// SPDX-License-Identifier: Apache-2.0
// Client side of coordination before the queue (Issue 1eb42254, D2): per-machine memory of the last
// stack offer. No server call: it reads the advice the receipt already carries.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { laneRegistryDirectory } from './lane-registry.js';

const disabled = () => Boolean(process.env.NODE_TEST_CONTEXT) && !process.env.XDG_STATE_HOME;
const stateFile = (kind: string, laneId: string) =>
  join(dirname(laneRegistryDirectory()), kind, `${laneId}.json`);
function readState<T>(kind: string, laneId: string, schema: z.ZodType<T>): T | null {
  if (disabled()) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(stateFile(kind, laneId), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
function writeState(kind: string, laneId: string, value: unknown) {
  if (disabled()) return;
  try {
    const target = stateFile(kind, laneId);
    if (value === null) return rmSync(target, { force: true });
    const temporary = join(dirname(target), `.${laneId}.${randomUUID()}`);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify(value));
    renameSync(temporary, target);
  } catch {
    /* Advisory: lost memory only skips an automatic stack. */
  }
}

const offerSchema = z.object({ peerLaneId: z.uuid(), mode: z.enum(['offer', 'auto']) });
/** The last stack offer a receipt carried for this Lane; a receipt without one clears it. */
export const rememberStackOffer = (
  laneId: string,
  offer: { peerLaneId: string; mode: 'offer' | 'auto' } | undefined,
) => writeState('stack-offer', laneId, offer ? { peerLaneId: offer.peerLaneId, mode: offer.mode } : null);
/** The peer an automatic stack (project setting stacking:auto) should use at this Lane's next sync. */
export function autoStackPeer(laneId: string) {
  const offer = readState('stack-offer', laneId, offerSchema);
  return offer?.mode === 'auto' ? offer.peerLaneId : undefined;
}
