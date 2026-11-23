// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Pure: also runs in the Convex non-Node runtime.
import { saveExpectedSchema, saveResultSchema, type SaveThen } from './hosted-save.js';
import { syncRequestSchema } from './hosted-sync.js';

/** The exact resolve sync request for a completed save. The CLI and the server's save-then-resolve
 * chain both build it here, so whichever prepares first, the other's prepare replays it. */
export function resolveSyncRequest(then: SaveThen, laneId: string, saved: unknown) {
  const lane = saveResultSchema.parse(saved);
  return syncRequestSchema.parse({
    kind: 'resolve',
    ...(then.holderSessionId ? { holderSessionId: then.holderSessionId } : {}),
    operationId: then.operationId,
    authorityEpoch: then.authorityEpoch,
    laneId,
    expected: saveExpectedSchema.parse({
      head: lane.head,
      version: lane.version,
      sourceVersion: lane.sourceVersion,
      lifecycleVersion: then.lifecycleVersion,
    }),
    message: then.message,
    ...(then.keep ? { keep: then.keep } : {}),
  });
}

/** How long the CLI waits, after its save completed, before checking whether it needs to
 * submit the chained resolve itself. */
export const chainStallMs = 10_000;
/** End a resolve's save wait at its chained resolve's receipt. At the stall bound or a chain
 * failure, the save receipt lets the caller continue with the sync's last observed status. */
export const chainSettle = (
  progress: unknown,
):
  | { value: { save: unknown; chained: { terminal: unknown; state: unknown } } }
  | { waitMs: number }
  | undefined => {
  const p = progress as {
    terminal?: { outcome?: { status?: string } } | null;
    chain?: { status?: string; terminal?: unknown; state?: unknown };
  } | null;
  if (p?.terminal?.outcome?.status !== 'completed' || !p.chain) return undefined;
  if (p.chain.terminal)
    return { value: { save: p.terminal, chained: { terminal: p.chain.terminal, state: p.chain.state } } };
  return p.chain.status === 'failed' ? undefined : { waitMs: chainStallMs };
};
