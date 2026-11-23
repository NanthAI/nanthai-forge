// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { ForgeError } from './errors.js';
import { FEED_RETENTION_MS, feedCursorSchema } from './feed-client.js';
import { decodeFeedPosition, laterFeedPosition } from './feed-position.js';
import { durableReplace } from './state/durability.js';
import { workLocked } from './work-lock.js';
import { undeliveredFeedEvent } from './watch-hooks.js';

const stateSchema = feedCursorSchema.extend({
  schema: z.literal(1),
  undelivered: z.array(undeliveredFeedEvent),
  updatedAt: z.number().int().nonnegative().optional(),
});
type WatchState = z.infer<typeof stateSchema>;

export function watchStateFile(path: string, startedAt: number) {
  const load = (): WatchState => {
    try {
      return stateSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { schema: 1, since: startedAt, seen: [], undelivered: [] };
      throw new ForgeError('BAD_ARGUMENT', `Cannot read the watch cursor at ${path}.`);
    }
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const update = (change: (current: WatchState) => void) =>
    workLocked(`${path}.lock`, () => {
      const state = load();
      change(state);
      durableReplace(path, JSON.stringify(state));
      return state;
    });
  const oldest = startedAt - FEED_RETENTION_MS;
  // A fresh cursor is durable before registration. An expired one is reset only
  // after the feed has validated current access and emitted its gap.
  const state = update(current => {
    current.undelivered = current.undelivered.filter(item => item.event.at >= oldest);
  });
  const last = state.updatedAt ?? state.since;
  const expired = last < oldest ? last : undefined;
  const cursor = expired === undefined ? state : { since: oldest, seen: [] };
  return {
    cursor,
    expired,
    pending: state.undelivered,
    reset() {
      update(current => {
        if ((current.updatedAt ?? current.since) !== expired) return;
        current.since = oldest;
        current.seen = [];
        delete current.after;
        delete current.historyFence;
        current.updatedAt = startedAt;
      });
    },
    checkpoint(next: z.infer<typeof feedCursorSchema>) {
      update(current => {
        const position = next.after && decodeFeedPosition(next.after);
        if (position && laterFeedPosition(position, current.after)) {
          current.after = next.after;
          delete current.historyFence;
          current.seen = next.seen;
        } else if (next.after === current.after) {
          current.historyFence ??= next.historyFence;
          if (current.historyFence === next.historyFence)
            current.seen = [...new Map([...current.seen, ...next.seen])];
        }
        current.since = Math.max(current.since, next.since);
        current.seen = current.seen.filter(
          ([id, at]) => at >= current.since || id.startsWith('queue.moved:'),
        );
        current.updatedAt = Date.now();
      });
    },
    retain(item: z.infer<typeof undeliveredFeedEvent>) {
      update(current => {
        const retained = current.undelivered.find(entry => entry.event.id === item.event.id);
        if (retained) retained.hooks = [...new Set([...retained.hooks, ...item.hooks])];
        else current.undelivered.push(item);
      });
    },
    complete(id: string, hook: z.infer<typeof undeliveredFeedEvent>['hooks'][number]) {
      update(current => {
        const item = current.undelivered.find(entry => entry.event.id === id);
        if (!item) return;
        item.hooks = item.hooks.filter(pending => pending !== hook);
        if (!item.hooks.length) current.undelivered = current.undelivered.filter(entry => entry !== item);
      });
    },
    close() {
      update(current => {
        current.updatedAt = Date.now();
      });
    },
  };
}
