// SPDX-License-Identifier: Apache-2.0
import { hydrateLandingHistory, hasJournalHistory } from './landing-capsule-client.js';
import { invariant } from './errors.js';
import { getFunctionName } from 'convex/server';
import { deadlineConvexSubscription } from './network-convex-client.js';
import { makeFunctionReference } from 'convex/server';
import type { FunctionReference } from 'convex/server';
import { coordinationCredentials } from './coordination-client.js';
import { ForgeError } from './errors.js';
import { COORDINATION_TOUCH_INTERVAL_MS } from './coordination-types.js';

type FeedPage = { page: unknown[]; isDone: boolean; continueCursor: string };
export interface CoordinationSubscription {
  action?(reference: FunctionReference<'action'>, args: Record<string, unknown>): Promise<unknown>;
  onUpdate(
    reference: FunctionReference<'query'>,
    args: Record<string, unknown>,
    update: (page: FeedPage) => void,
    error: (error: Error) => void,
  ): () => void;
  close(): Promise<void>;
}
export type WatchInput = {
  cursor: string | null;
  pageSize: number;
  waitMs: number;
  /** Heartbeat this session while waiting (last-seen only). */
  sessionId?: string | undefined;
  /** Only events related to your claims, the session's scope or the given scope. */
  related?: boolean | undefined;
  intentIds?: string[] | undefined;
  laneIds?: string[] | undefined;
  paths?: string[] | undefined;
  includeMine?: boolean | undefined;
};
/** A bounded live query; timeout only counts as observed silence after a successful authorized read. */
export async function watchCoordinationFeed(
  client: CoordinationSubscription,
  projectId: string,
  input: WatchInput,
  touch?: (sessionId: string) => Promise<unknown>,
) {
  let active = true,
    generation = 0;
  let unsubscribe: (() => void) | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    beat: ReturnType<typeof setInterval> | undefined;
  const sessionId = input.sessionId;
  const heartbeat = () => {
    if (touch && sessionId) void touch(sessionId).catch(() => undefined); // Advisory; the watch result is unaffected.
  };
  heartbeat();
  if (touch && sessionId) beat = setInterval(heartbeat, COORDINATION_TOUCH_INTERVAL_MS);
  const paginationOpts = { cursor: input.cursor, numItems: input.pageSize };
  const [reference, args] = input.related
    ? [
        makeFunctionReference<'query'>('projectCoordinationReads:related'),
        {
          projectId,
          paginationOpts,
          ...Object.fromEntries(
            Object.entries({
              sessionId,
              intentIds: input.intentIds,
              laneIds: input.laneIds,
              paths: input.paths,
              includeMine: input.includeMine,
            }).filter(([, value]) => value !== undefined),
          ),
        },
      ]
    : [makeFunctionReference<'query'>('projectCoordination:feed'), { projectId, paginationOpts }];
  try {
    return await new Promise<FeedPage & { timedOut: boolean }>((resolve, reject) => {
      let latest: FeedPage | undefined;
      timer = setTimeout(
        () =>
          latest
            ? resolve({ ...latest, timedOut: true })
            : reject(
                new ForgeError(
                  'COORDINATION_UNAVAILABLE',
                  'No authorized feed observation arrived before the wait ended. Retain the original cursor and check current authentication/network.',
                ),
              ),
        input.waitMs,
      );
      const observe = (page: unknown) => {
        const selected = ++generation;
        const apply = (value: unknown) => {
          if (!active || selected !== generation) return;
          const parsed = (typeof value === 'string' ? JSON.parse(value) : value) as FeedPage;
          latest = parsed;
          if (parsed.page.length) resolve({ ...parsed, timedOut: false });
        };
        if (!hasJournalHistory(page)) {
          apply(page);
          return;
        }
        const hydrated = hydrateLandingHistory(getFunctionName(reference), args, page, (name, input) => {
          invariant(
            client.action,
            'HOSTED_ACTION_UNSUPPORTED',
            'Update this coordination client to read archived history.',
          );
          return client.action(makeFunctionReference<'action'>(name), { ...input, projectId });
        });
        void hydrated.then(apply, reject);
      };
      unsubscribe = client.onUpdate(reference, args, observe, error =>
        hasJournalHistory(error)
          ? observe(error)
          : reject(
              new ForgeError(
                'COORDINATION_UNAVAILABLE',
                'The live feed failed or current authority expired. Retain the original cursor and obtain current authentication through the existing integration.',
              ),
            ),
      );
    });
  } finally {
    active = false;
    generation++;
    if (timer) clearTimeout(timer);
    if (beat) clearInterval(beat);
    unsubscribe?.();
    await client.close();
  }
}
export function watchCoordination(
  deployment: string,
  token: string | undefined,
  projectId: string,
  input: WatchInput,
) {
  const credentials = coordinationCredentials(deployment, token);
  const client = deadlineConvexSubscription(credentials.url, { logger: false, unsavedChangesWarning: false });
  // A bounded call uses only the explicitly supplied credential; no refresh/elevation side channel.
  client.setAuth(async () => credentials.token);
  return watchCoordinationFeed(client, projectId, input, sessionId =>
    client.mutation(makeFunctionReference<'mutation'>('projectCoordination:touch'), { projectId, sessionId }),
  );
}
