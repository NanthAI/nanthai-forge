// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useCallback, useMemo, useRef, useState } from 'react';
import { useMutation, useQueries } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { Answer, ThreadPage } from './conversation';
import { useSafeQuery } from '../../safe-query';

type Cursor = NonNullable<ThreadPage['before']>;
const noPages: Cursor[] = [];
const cursorKey = (cursor: Cursor | null | undefined) =>
  cursor ? JSON.stringify([cursor.note, cursor.message, cursor.handoff, cursor.intentMessage]) : null;

export function useConversation(projectId: Id<'hostedProjects'>, scope: 'lane' | 'item', id: string) {
  const query = api.projectDiscussionThread.read;
  const { value: first, error } = useSafeQuery(query, { projectId, scope, id });
  const boundary = first?.canRead ? cursorKey(first.before) : null;
  const [history, setHistory] = useState<{ boundary: string; pages: Cursor[]; attempt: number }>();
  const sameWindow = boundary !== null && history?.boundary === boundary;
  const requested = sameWindow ? history.pages : noPages;
  const attempt = sameWindow ? history.attempt : 0;
  const requests = useMemo(
    () =>
      Object.fromEntries(
        requested.map((before, i) => [
          `${i}:${attempt}`,
          { query: api.projectDiscussionThread.read, args: { projectId, scope, id, before } },
        ]),
      ),
    [requested, attempt, projectId, scope, id],
  );
  const observed = useQueries(requests);
  const pages = first?.canRead ? [first] : [];
  let loadingMore = false;
  let failed = false;
  for (const [i, cursor] of requested.entries()) {
    if (cursorKey(cursor) !== cursorKey(pages.at(-1)?.before)) break;
    const page = observed[`${i}:${attempt}`] as ThreadPage | Error | undefined;
    if (page instanceof Error) {
      failed = true;
      break;
    }
    if (!page) {
      loadingMore = true;
      break;
    }
    if (!page.canRead) break;
    pages.push(page);
  }
  const before = pages.at(-1)?.before;
  // If a new message changes the head boundary, start earlier pages from that boundary.
  // Live ranges keep an answer or acknowledgement on any opened page current.
  const loadEarlier =
    boundary && before
      ? () => {
          if (!loadingMore)
            setHistory({
              boundary,
              pages: [...requested.slice(0, pages.length - 1), before],
              attempt: attempt + Number(failed),
            });
        }
      : undefined;
  const entries = new Map(pages.flatMap(page => page.entries).map(row => [row.id, row]));
  return {
    entries: [...entries.values()],
    loading: !first && !error,
    readFailed: Boolean(error),
    loadingMore,
    failed,
    loadEarlier,
  };
}

/** A failed or unknown send can be retried without recording a second decision. */
export function useAnswer(projectId: Id<'hostedProjects'>): Answer {
  const publish = useMutation(api.projectCoordination.publish);
  const attempts = useRef(new Map<string, { choice: string; reason: string; operationId: string }>());
  return useCallback(
    async ({ id }, choice, reason = '') => {
      const last = attempts.current.get(id);
      const operationId =
        last?.choice === choice && last.reason === reason ? last.operationId : crypto.randomUUID();
      attempts.current.set(id, { choice, reason, operationId });
      await publish({
        projectId,
        operationId,
        command: { kind: 'ack', messageId: id, choice, text: reason },
      });
      attempts.current.delete(id);
    },
    [projectId, publish],
  );
}
