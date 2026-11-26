// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';
import { landingStallSchema } from './landing-stall-schema.js';
import { ForgeError, invariant } from './errors.js';
import { feedAttentionReasons, feedKinds } from './feed-event.js';
import type { HostedRunSubscription } from './hosted-agent-observe.js';
import { hostedActionError } from './hosted-action-error.js';
import { withExchangeProgress } from './exchange-progress.js';
import { decodeFeedPosition, laterFeedPosition } from './feed-position.js';
import { hostedLandingStateSchema, landingObservationSchema } from './hosted-landing.js';

export const FEED_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const FEED_OVERLAP_MS = 30_000;
const pageRef = makeFunctionReference<'query'>('projectFeed:page');
const timestamp = z.number().int().nonnegative();
export const feedEventSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1).max(200),
  kind: z.enum(feedKinds),
  at: timestamp,
  projectId: z.string(),
  laneId: z.uuid(),
  operationId: z.uuid().optional(),
  submissionId: z.uuid().optional(),
  receiptId: z.string().optional(),
  code: z.string().optional(),
  runId: z.uuid().optional(),
  noteId: z.string().optional(),
  position: timestamp.optional(),
  reason: z.enum(feedAttentionReasons).optional(),
  sourceVersion: timestamp.optional(),
  resume: z.union([
    z.object({
      action: z.literal('wait'),
      input: z.union([
        z.object({ operationIds: z.tuple([z.uuid()]), until: z.literal('acceptance') }),
        z.object({ runId: z.uuid() }),
      ]),
    }),
    z.object({ action: z.enum(['board', 'status']), input: z.object({ laneId: z.uuid() }) }),
  ]),
});
export type ProjectFeedEvent = z.infer<typeof feedEventSchema>;
const feedPageSchema = z.object({
  events: z.array(feedEventSchema).max(33),
  more: z.boolean(),
  cursor: z.string().nullable(),
  arrival: z.object({ after: z.string(), scanned: timestamp.max(33) }).optional(),
  waiting: z
    .array(
      z.object({
        submissionId: z.uuid(),
        phase: hostedLandingStateSchema.shape.phase,
        version: timestamp,
        needsSync: z.boolean(),
        pending: z
          .object({
            attemptId: z.uuid(),
            reason: landingObservationSchema.shape.pendingReason,
            holdCode: z.enum(['MAIN_RED', 'CI_DOWN']).optional(),
            orderWait: z.uuid().optional(),
            lastProgressAt: z.iso.datetime().optional(),
            stall: landingStallSchema.optional(),
          })
          .optional(),
      }),
    )
    .max(32)
    .optional(),
});
type FeedWaitObservation = NonNullable<z.infer<typeof feedPageSchema>['waiting']>[number];
export const feedCursorSchema = z.object({
  since: timestamp,
  seen: z.array(z.tuple([z.string(), timestamp])),
  after: z.string().optional(),
  historyFence: z.string().optional(),
});
type FeedCursor = z.infer<typeof feedCursorSchema>;
export type FeedSelection = (
  | { project: true; mine?: true; lanes?: never }
  | { lanes: string[]; project?: never; mine?: never }
) & {
  projectId: string;
  kinds?: ProjectFeedEvent['kind'][];
  queue?: { laneId: string };
  waitFor?: string[];
};

function decodePage(value: unknown, selection: FeedSelection) {
  const result = feedPageSchema.safeParse(value);
  invariant(
    result.success &&
      result.data.more === Boolean(result.data.cursor) &&
      result.data.events.every(
        event =>
          event.projectId === selection.projectId &&
          (!selection.lanes || selection.lanes.includes(event.laneId)) &&
          (!selection.kinds || selection.kinds.includes(event.kind)),
      ),
    'HOSTED_PROTOCOL_INVALID',
    'The event feed page differs from the requested selection.',
  );
  return result.data;
}

/** One live query. Finite continuations walk the raw index even when a filtered page is
 * empty. The subscription stays attached during the crawl and coalesces newer snapshots. */
export async function consumeProjectFeed(options: {
  selection: FeedSelection;
  cursor: FeedCursor;
  subscribe: () => HostedRunSubscription;
  read: (args: Record<string, unknown>) => Promise<unknown>;
  signal: AbortSignal;
  event: (event: ProjectFeedEvent) => void | Promise<void>;
  checkpoint?: (cursor: FeedCursor) => void;
  ready?: () => void;
  waiting?: (observations: FeedWaitObservation[]) => void | Promise<void>;
  /** Replay old event-time rows while capturing the live commit fence once. */
  replay?: boolean;
}) {
  const { signal, selection } = options;
  if (signal.aborted) return;
  let { since, after, historyFence } = options.cursor;
  const seen = new Map(options.cursor.seen);
  const liveSeen = new Set<string>();
  let newest = since,
    snapshot: { value: unknown } | undefined,
    failure: ForgeError | undefined,
    wake = () => {},
    unsubscribe: (() => void) | undefined,
    ready = false;
  const client = options.subscribe();
  const listen = () => {
    unsubscribe?.();
    snapshot = undefined;
    liveSeen.clear();
    unsubscribe = client.onUpdate(
      pageRef,
      {
        ...selection,
        since,
        arrival: {
          after: after ?? historyFence ?? null,
          ...(after === undefined && options.replay ? { replay: true } : {}),
        },
      },
      value => {
        snapshot = { value };
        wake();
      },
      error => {
        failure = hostedActionError(error, 'project feed');
        wake();
      },
    );
  };
  const stop = () => wake();
  const checkpoint = () =>
    options.checkpoint?.({
      since,
      seen: [...seen],
      ...(after ? { after } : {}),
      ...(historyFence ? { historyFence } : {}),
    });
  const compactHistory = () => {
    since = Math.max(since, newest - FEED_OVERLAP_MS);
    for (const [id, at] of seen) if (at < since && !id.startsWith('queue.moved:')) seen.delete(id);
  };
  signal.addEventListener('abort', stop);
  try {
    listen();
    while (!signal.aborted) {
      if (failure) throw failure;
      if (!snapshot) {
        await new Promise<void>(resolve => {
          wake = resolve;
        });
        continue;
      }
      let page = decodePage(snapshot.value, selection);
      snapshot = undefined;
      const arrival = page.arrival;
      const position = arrival && decodeFeedPosition(arrival.after);
      invariant(
        arrival && position,
        'HOSTED_PROTOCOL_INVALID',
        'The live project feed omitted its arrival cursor.',
      );
      if (!ready) {
        ready = true;
        options.ready?.();
      }
      const bootstrapping = after === undefined;
      const historySince = since;
      if (bootstrapping && options.replay && !historyFence) {
        historyFence = arrival.after;
        checkpoint();
      }
      do {
        for (const event of page.events) {
          if (signal.aborted) return;
          if (failure) throw failure;
          const queue = event.kind === 'queue.moved';
          if (seen.has(event.id) || liveSeen.has(event.id)) continue;
          await options.event(event);
          if (signal.aborted) return;
          // Queue positions carry the queue's clock rather than a stored event timestamp.
          // Keep the current submission's position identities without advancing the stored range.
          if (queue) {
            const submission = `queue.moved:${event.submissionId}:`;
            for (const id of seen.keys())
              if (id.startsWith('queue.moved:') && !id.startsWith(submission)) seen.delete(id);
          } else newest = Math.max(newest, event.at);
          seen.set(event.id, event.at);
          if (!queue && !bootstrapping) liveSeen.add(event.id);
          checkpoint();
        }
        const cursor = page.cursor;
        // Live commit pages resume on the same subscription slot, independent of event time.
        if (!bootstrapping || !cursor) break;
        compactHistory();
        checkpoint();
        if (signal.aborted) return;
        if (failure) throw failure;
        const next = await withExchangeProgress({ signal }, () =>
          options.read({
            ...selection,
            since: historySince,
            cursor,
            arrival: { after: arrival.after, replay: true },
          }),
        );
        page = decodePage(next, selection);
        invariant(page.cursor !== cursor, 'HOSTED_PROTOCOL_INVALID', 'Feed continuation did not advance.');
      } while (!signal.aborted);
      if (signal.aborted) return;
      if (page.waiting) await options.waiting?.(page.waiting);
      const advanced = laterFeedPosition(position, after);
      if (advanced) {
        after = arrival.after;
        historyFence = undefined;
        for (const id of liveSeen) seen.delete(id);
        compactHistory();
        checkpoint();
      }
      if (bootstrapping || (arrival.scanned >= 16 && advanced)) {
        listen();
      }
    }
  } finally {
    signal.removeEventListener('abort', stop);
    try {
      unsubscribe?.();
    } finally {
      await client.close();
    }
  }
}
