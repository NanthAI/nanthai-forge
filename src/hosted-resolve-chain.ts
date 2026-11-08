// SPDX-License-Identifier: Apache-2.0
// Pure: also runs in the Convex non-Node runtime.
import { saveExpectedSchema, saveResultSchema, type SaveThen } from './hosted-save.js';
import { syncRequestSchema } from './hosted-sync.js';

/** The exact resolve sync request for a completed save. The CLI and the server's save-then-resolve
 * chain both build it here, so whichever prepares first, the other's prepare replays it. */
export function resolveSyncRequest(then: SaveThen, laneId: string, saved: unknown) {
  const lane = saveResultSchema.parse(saved);
  return syncRequestSchema.parse({
    kind: 'resolve',
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
  });
}

/** How long the CLI waits, after its save completed, for the server's chained resolve before it
 * resolves itself (an identical, idempotent request, so both converge). */
export const chainStallMs = 10_000;
/** End a resolve's save wait (save-then-resolve) at the chained resolve's receipt; at a chain
 * failure, or once the stall bound passes without that receipt, end it at the save's own receipt
 * so the CLI resolves itself. A save that did not complete ends the wait as before. */
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
  if (p?.terminal?.outcome?.status !== 'completed' || !p.chain || p.chain.status === 'failed')
    return undefined;
  if (p.chain.terminal)
    return { value: { save: p.terminal, chained: { terminal: p.chain.terminal, state: p.chain.state } } };
  return { waitMs: chainStallMs };
};
