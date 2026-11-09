// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';
import { boardDeliverySchema } from './hosted-board.js';
import { boardEnvelope, readBoardCursor, readBoardWokeAt, writeBoardWokeAt } from './board-local.js';
import { ForgeError } from './errors.js';
import { memberDataNotice } from './member-data-notice.js';
import { hostedActionError } from './hosted-action-error.js';
import { isNetworkPending } from './network-continuation.js';
import { hostedRunSubscription, type HostedRunSubscription } from './hosted-agent-observe.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';
import { parseHostedResponse, safeParseHostedResponse } from './hosted-response.js';

/** Replaceable in tests; production subscribes with the live Convex client. */
export const peerWaitHooks: {
  subscribe?: (address: HostedAgentTransport['address']) => HostedRunSubscription;
} = {};
export type BoardDelivery = z.infer<typeof boardDeliverySchema>;
/** At most one early wait return per Lane per this window; later notes wait for the next return. */
export const BOARD_WAKE_WINDOW_MS = 60_000;
/** Notes arriving together are returned together. Replaceable in tests. */
export const boardWakeTiming = {
  batchMs: 2_000,
  windowMs: BOARD_WAKE_WINDOW_MS,
};

export { readBoardServerFeatures, rememberBoardServerFeatures, readBoardWokeAt } from './board-local.js';

/** What a wait passes to its subscription: the caller's own Lane and its local cursor. */
export type BoardWaitOption = { laneId: string; after: number; wokeAt: number };
export function boardWaitOption(root: string, laneId: string | undefined): BoardWaitOption | undefined {
  if (!laneId) return undefined;
  return {
    laneId,
    after: readBoardCursor(root, laneId),
    wokeAt: readBoardWokeAt(root, laneId),
  };
}

/** Turns subscription values into at most one early return: waits batchMs for notes arriving
 * together, and no earlier than windowMs after this Lane's previous early return. Local timers
 * only; no call. */
export function boardWaker(option: BoardWaitOption, wake: (delivery: BoardDelivery) => void) {
  let latest: BoardDelivery | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    offer(value: unknown) {
      const parsed = safeParseHostedResponse(
        boardDeliverySchema,
        (value as { board?: unknown } | undefined)?.board,
      );
      if (!parsed.success || !parsed.data.messages.length) return;
      latest = parsed.data;
      if (timer) return;
      const at = Math.max(Date.now() + boardWakeTiming.batchMs, option.wokeAt + boardWakeTiming.windowMs);
      timer = setTimeout(() => wake(latest!), Math.max(0, at - Date.now()));
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** The early return's envelope: writes the board cursor and this Lane's wake time (two local
 * files), so the same notes are not shown again and the next early return waits its window. */
export function boardWakeEnvelope(root: string, laneId: string, delivery: BoardDelivery) {
  const envelope = boardEnvelope(root, laneId, delivery);
  writeBoardWokeAt(root, laneId);
  return delivery.messages.length ? { ...envelope, notice: memberDataNotice } : envelope;
}

const peerSchema = z.object({
  peer: z.looseObject({
    laneId: z.string(),
    intentId: z.string().optional(),
    state: z.enum(['open', 'accepted', 'completed', 'abandoned', 'closed', 'failed', 'cancelled']),
    terminal: z.boolean(),
    actor: z.string().optional(),
    receiptId: z.string().optional(),
    commit: z.string().optional(),
    at: z.string().optional(),
    landing: z
      .looseObject({ operationId: z.string(), phase: z.string(), code: z.string().optional() })
      .optional(),
  }),
  board: z.unknown().optional(),
});
type PeerOutcome =
  | { status: 'terminal'; peer: z.infer<typeof peerSchema>['peer'] }
  | {
      status: 'message';
      peer: z.infer<typeof peerSchema>['peer'] | null;
      board: BoardDelivery;
    }
  | {
      status: 'timeout' | 'cancelled';
      peer: z.infer<typeof peerSchema>['peer'] | null;
    };

/**
 * Wait until a peer Lane lands, its latest landing fails or is cancelled, or the Lane closes, or a note reaches the caller's own Lane. One capability
 * read (as every wait), then ONE live subscription to projectBoardWait:peer for the length of the
 * wait: it re-runs only when the peer's head/overlap row or the caller's inbox row changes. No
 * polling, no other query, nothing after the process exits.
 */
export async function observePeerLane(
  transport: HostedAgentTransport,
  input: { peer: string; timeoutSeconds: number },
  board: BoardWaitOption | undefined,
  signal?: AbortSignal,
  subscribe: () => HostedRunSubscription = () =>
    (peerWaitHooks.subscribe ?? hostedRunSubscription)(transport.address),
): Promise<PeerOutcome> {
  const discovery = await transport.dispatch('capabilities', {});
  if (isNetworkPending(discovery))
    throw new ForgeError('EXCHANGE_REQUEST_FAILED', 'Observation is unavailable; run the same wait again.');
  const features = ((discovery.result as { features?: unknown }).features ?? []) as string[];
  if (!Array.isArray(features) || !features.includes('board-wait'))
    throw new ForgeError(
      'HOSTED_ACTION_UNSUPPORTED',
      'This Forge server cannot wait for a peer Lane yet (feature board-wait). Nothing was changed.',
    );
  let latest: z.infer<typeof peerSchema>['peer'] | null = null;
  if (signal?.aborted) return { status: 'cancelled', peer: latest };
  const client = subscribe();
  let release = () => {};
  try {
    return await new Promise<PeerOutcome>((resolve, reject) => {
      const settle = (value: PeerOutcome) => {
        release();
        resolve(value);
      };
      const waker = board
        ? boardWaker(board, delivery => settle({ status: 'message', peer: latest, board: delivery }))
        : undefined;
      const timer = input.timeoutSeconds
        ? setTimeout(() => settle({ status: 'timeout', peer: latest }), input.timeoutSeconds * 1000)
        : undefined;
      const stop = () => settle({ status: 'cancelled', peer: latest });
      const unsubscribe = client.onUpdate(
        makeFunctionReference<'query'>('projectBoardWait:peer'),
        {
          projectId: transport.address.projectId,
          peer: input.peer.toLowerCase(),
          ...(board ? { laneId: board.laneId, after: board.after } : {}),
        },
        value => {
          try {
            const parsed = parseHostedResponse(
              peerSchema,
              typeof value === 'string' ? JSON.parse(value) : value,
            );
            latest = parsed.peer;
            if (parsed.peer.terminal) settle({ status: 'terminal', peer: parsed.peer });
            else waker?.offer(parsed);
          } catch (error) {
            release();
            reject(
              error instanceof z.ZodError || error instanceof SyntaxError
                ? new ForgeError('HOSTED_PROTOCOL_INVALID', 'Peer Lane observation is invalid.')
                : error,
            );
          }
        },
        error => {
          release();
          reject(hostedActionError(error, 'peer Lane observation'));
        },
      );
      release = () => {
        if (timer) clearTimeout(timer);
        waker?.stop();
        signal?.removeEventListener('abort', stop);
        unsubscribe();
        release = () => {};
      };
      signal?.addEventListener('abort', stop, { once: true });
      if (!input.timeoutSeconds) setImmediate(() => settle({ status: 'timeout', peer: latest }));
    });
  } finally {
    release();
    await client.close();
  }
}
