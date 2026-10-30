import { useOverlapAnswers } from './overlap-answers';
import { useToast } from '../ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext, useRef } from 'react';
import { PendingWrite } from '../pending-write';
import { activityAt, collapseSessions } from '../../../src/presence';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, usePaginatedQuery, useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import {
  sessionForest,
  activityAuthor,
  eventText,
  flattenSessions,
  isPersonSession,
  type ActivityEvent,
  type Session,
} from '../coordination-view';
import { hostedError } from '../snapshot';
import { freshness } from '../ui/status';

import type { DecisionItem, FeedItem } from './attention';
import { overlapRows, type OverlapRow } from './overlap-model';
import type { CockpitLane, CockpitWork } from './model';

/** Presence needs every descendant, without expanding any branch in a server transaction. */
export function usePresenceSessions(projectId: Id<'hostedProjects'>, enabled = true) {
  const page = usePaginatedQuery(
    api.projectCoordination.sessions,
    enabled ? { projectId, all: true } : 'skip',
    { initialNumItems: 50 },
  );
  useEffect(() => {
    if (page.status === 'CanLoadMore') page.loadMore(50);
  }, [page.status, page.loadMore]);
  const results = useMemo(() => sessionForest(page.results as Session[]), [page.results]);
  return { ...page, results };
}

/**
 * Live coordination for one hosted project: sessions with last-seen, the viewer's unacknowledged
 * messages and handoffs, active claims and recent events. All advisory observations.
 */
export const CoordinationContext = createContext<ReturnType<typeof useLiveCoordination> | null>(null);
export function useCoordination(projectId: Id<'hostedProjects'>) {
  const shared = useContext(CoordinationContext);
  const live = useLiveCoordination(projectId, !shared);
  return shared ?? live;
}
export function useLiveCoordination(projectId: Id<'hostedProjects'>, enabled: boolean) {
  const sessions = usePresenceSessions(projectId, enabled);
  const recent = usePaginatedQuery(api.projectCoordination.recent, enabled ? { projectId } : 'skip', {
    initialNumItems: 40,
  });
  const unacked = useQuery(api.projectCoordinationReads.unacked, enabled ? { projectId, limit: 20 } : 'skip');
  const counts = useQuery(api.projectCoordination.counts, enabled ? { projectId } : 'skip');
  const claims = useQuery(api.projectCoordinationReads.claims, enabled ? { projectId } : 'skip');
  const rawAnswers = useQuery(
    api.projectHostedOverlapAcks.list,
    enabled ? { projectId, cursor: null, signals: true } : 'skip',
  );
  const overlaps = useMemo(
    () =>
      rawAnswers
        ? (JSON.parse(rawAnswers) as {
            page: import('./overlap-model').OverlapAnswer[];
            isDone: boolean;
            signals?: import('../../../src/now-overlap-signals').NowOverlapSignals;
          })
        : undefined,
    [rawAnswers],
  );
  return {
    overlapAnswers: overlaps?.page ?? [],
    overlapSignals: overlaps?.signals,
    overlapsComplete: overlaps?.isDone !== false && overlaps?.signals?.complete !== false,
    sessions: sessions.results as Session[],
    sessionsLoading: sessions.status !== 'Exhausted',
    sessionsComplete: sessions.status === 'Exhausted',
    loadMoreSessions: () => sessions.loadMore(50),
    eventsComplete: recent.status === 'Exhausted',
    eventsLoading: recent.status === 'LoadingFirstPage' || recent.status === 'LoadingMore',
    loadMoreEvents: () => recent.loadMore(40),
    events: recent.results as ActivityEvent[],
    eventsPaging: {
      more: recent.status === 'CanLoadMore',
      loading: recent.status === 'LoadingMore',
      loadMore: () => recent.loadMore(40),
    },
    unacked: unacked?.items ?? [],
    unackedComplete: unacked?.complete ?? true,
    claims: claims?.claims ?? [],
    ...(counts ? { counts } : {}),
    initialLoading: unacked === undefined || claims === undefined || rawAnswers === undefined,
    loading:
      unacked === undefined ||
      claims === undefined ||
      rawAnswers === undefined ||
      sessions.status !== 'Exhausted',
  };
}

type Command = Parameters<
  ReturnType<typeof useMutation<typeof api.projectCoordination.publish>>
>[0]['command'];

/**
 * Answers to messages and handoffs: acknowledge, or reply to the sender and then acknowledge.
 * Each attempt keeps its operation id until it succeeds, so a retry never publishes twice.
 */
export function useAnswers(projectId: Id<'hostedProjects'>, viewerName?: string) {
  const overlaps = useOverlapAnswers(projectId, viewerName);
  const toast = useToast();
  const publish = useMutation(api.projectCoordination.publish);
  const writer = useRef<PendingWrite<Command, unknown> | null>(null);
  writer.current ??= new PendingWrite(attempt => publish({ projectId, ...attempt }));
  const [pending, setPending] = useState<Record<string, { operationId: string; command: Command }>>({});
  const [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  const writes = useRef(new Map<string, PendingWrite<Command, unknown>>());
  const completed = useRef(new Map<string, string>());
  const send = async (key: string, command: Command) => {
    const payload = JSON.stringify(command);
    if (completed.current.get(key) === payload) return;
    let write = writes.current.get(key);
    if (!write) {
      write = new PendingWrite(attempt => publish({ projectId, ...attempt }));
      writes.current.set(key, write);
    }
    setPending(previous => ({ ...previous, [key]: { operationId: 'pending', command } }));
    await write.send(command);
    completed.current.set(key, payload);
    setPending(previous => {
      const next = { ...previous };
      delete next[key];
      return next;
    });
  };
  const run = async (messageId: string, steps: () => Promise<void>) => {
    setBusy(messageId);
    setError('');
    try {
      await steps();
      toast.show({ message: 'Acknowledged.', tone: 'success' });
      return true;
    } catch (e) {
      toast.show({ message: hostedError(e), retry: () => run(messageId, steps) });
      return false;
    } finally {
      setBusy('');
    }
  };
  const acknowledge = (messageId: string, text: string, choice?: string) =>
    run(messageId, () =>
      send(`ack:${messageId}`, { kind: 'ack', messageId, text, ...(choice ? { choice } : {}) }),
    );
  const reply = (messageId: string, recipient: string, text: string, laneId?: string) =>
    run(messageId, async () => {
      await send(`reply:${messageId}`, {
        kind: 'message',
        recipient,
        text,
        context: laneId ? { laneId } : {},
      });
      await send(`ack:${messageId}`, { kind: 'ack', messageId, text: 'Replied.' });
    });
  /** A short request to a session to hold off on a file; retry-safe like every other answer. */
  const tell = async (target: { recipient: string; laneId?: string }, path: string) => {
    try {
      await send(`tell:${target.recipient}:${path}`, {
        kind: 'message',
        recipient: target.recipient,
        text: `Please hold off on ${path} for now: another Lane is changing it too.`,
        context: { paths: [path], ...(target.laneId ? { laneId: target.laneId } : {}) },
      });
      return true;
    } catch (e) {
      toast.show({ message: hostedError(e), retry: () => tell(target, path) });
      return false;
    }
  };
  /** Sends a prompt to a session's inbox; the same text to the same session is published once. */
  const message = (recipient: string, text: string, laneId?: string) =>
    send(`message:${recipient}:${laneId ?? ''}:${text}`, {
      kind: 'message',
      recipient,
      text,
      context: laneId ? { laneId } : {},
    });
  const retrying = (messageId: string) =>
    Boolean(pending[`ack:${messageId}`] || pending[`reply:${messageId}`]);
  return {
    acknowledgeOverlaps: overlaps.acknowledgeOverlaps,
    acknowledge,
    reply,
    tell,
    message,
    busy,
    error: overlaps.error || error,
    retrying,
    publish: (command: Command) => writer.current!.send(command),
  };
}

/** File count from each Lane's latest server change event, when the Lane has no line counts. */
export function withChangedFiles(lanes: readonly CockpitLane[], events: readonly ActivityEvent[]) {
  const files = new Map<string, number>();
  for (const event of events) {
    const command = event.command;
    if (command.kind !== 'change' || !command.laneId || files.has(command.laneId)) continue;
    const count = command.pathCount ?? command.paths?.length;
    if (count) files.set(command.laneId, count);
  }
  return lanes.map(lane =>
    lane.changes || !files.has(lane.id) ? lane : { ...lane, changes: { files: files.get(lane.id)! } },
  );
}

/** The freshest unfinished session reporting each Lane. */
export function withSessions(
  lanes: readonly CockpitLane[],
  sessions: readonly Session[],
  now: number,
  includeEnded = false,
) {
  const byLane = new Map<string, Session>();
  for (const session of collapseSessions(flattenSessions(sessions))) {
    const laneId = session.context.laneId;
    if (
      !laneId ||
      (!includeEnded && session.status === 'completed') ||
      /^agent workflow$/i.test(session.name.trim())
    )
      continue;
    const known = byLane.get(laneId);
    const ended = session.status === 'completed',
      knownEnded = known?.status === 'completed';
    if (!known || (!ended && knownEnded) || (ended === knownEnded && known.lastSeen < session.lastSeen))
      byLane.set(laneId, session);
  }
  return lanes.map(lane => {
    const session = byLane.get(lane.id);
    return session
      ? {
          ...lane,
          ...(lane.runStatus === 'failed'
            ? {
                fact: lane.fact.replace(' · nobody’s on it', ''),
              }
            : {}),
          session: {
            name: session.name,
            ...(includeEnded ? { status: session.status } : {}),
            id: session.sessionId,
            environment: session.environment,
            lastSeen: activityAt(session),
            tone: freshness(activityAt(session), now, session.status),
            ...(isPersonSession(session) ? { person: true } : {}),
            ...(session.harness ? { harness: session.harness } : {}),
          },
        }
      : lane;
  });
}

export function hostedDecisions(
  unacked: readonly ActivityEvent[],
  sessions: readonly Session[],
  lanes: readonly CockpitLane[],
  records?: Pick<CockpitWork, 'lanes' | 'intents'>,
): DecisionItem[] {
  const laneName = new Map(lanes.map(lane => [lane.id, lane.name]));
  return unacked.flatMap((event): DecisionItem[] => {
    const command = event.command;
    if (command.kind !== 'message' && command.kind !== 'handoff') return [];
    if (command.kind === 'message' && !event.recipientActor && !command.recipient) return [];
    const laneId = command.kind === 'handoff' ? command.laneId : command.context.laneId;
    const lane = laneId ? laneName.get(laneId) : undefined;
    const sessionId = 'sessionId' in command ? command.sessionId : undefined;
    const senderSession = flattenSessions(sessions).find(session =>
      sessionId ? session.sessionId === sessionId : session.name === activityAuthor(event, [...sessions]),
    );
    const context =
      senderSession?.context.laneId || senderSession?.context.intentId
        ? senderSession.context
        : command.kind === 'message'
          ? command.context
          : command;
    const senderLane = records?.lanes.find(lane => lane.id === context.laneId);
    const senderIntent = records?.intents.find(
      intent => intent.id === (context.intentId ?? senderLane?.intentId),
    );
    if (
      senderLane?.state === 'completed' ||
      senderLane?.state === 'abandoned' ||
      senderIntent?.status === 'completed' ||
      senderIntent?.status === 'abandoned'
    )
      return [];
    const sender = {
      name: activityAuthor(event, [...sessions]),
      agent: senderSession
        ? !isPersonSession(senderSession)
        : /^(gpt|claude|codex|gemini)-/i.test(activityAuthor(event, [...sessions])),
    };
    const broadcast = command.kind === 'message' && !event.recipientActor && !command.recipient;
    const firstSentence =
      command.kind === 'message'
        ? command.text
            .trim()
            .match(/^.*?(?:[.!?](?=\s|$)|\n|$)/)?.[0]
            ?.trim() || 'Message'
        : '';
    return [
      {
        id: `event:${event.operationId}`,
        kind: command.kind,
        sender,
        audience: broadcast ? 'to everyone' : 'to you',
        broadcast,
        title:
          command.kind === 'handoff'
            ? (lane ?? 'Work')
            : broadcast
              ? firstSentence
              : lane
                ? `About ${lane}`
                : firstSentence,
        quote: {
          from: sender.name,
          ...(event.recipientActor ? { to: 'you' } : {}),
          text:
            command.kind === 'handoff'
              ? command.summary
              : lane
                ? command.text
                : command.text.trim().slice(firstSentence.length).trim(),
        },
        at: event.at,
        messageId: event.operationId,
        ...(command.kind === 'message'
          ? {
              replyTo: command.sessionId ?? event.actor,
              question: command.text.includes('?') || Boolean(command.choices?.length),
              ...(command.choices?.length ? { choices: command.choices.slice(0, 3) } : {}),
            }
          : {}),
        ...(laneId ? { laneId } : {}),
        ...(command.kind === 'message' && command.context.intentId
          ? { intentId: command.context.intentId }
          : {}),
      },
    ];
  });
}

/**
 * Hosted overlaps: files two Lanes' latest reported changes share, and paths two sessions claimed.
 * A claim can be answered with a message to its session.
 */
export function hostedOverlaps(
  claims: readonly { actor: string; sessionId?: string; paths: string[]; laneId?: string; note?: string }[],
  sessions: readonly Session[],
  lanes: readonly CockpitLane[],
  events: readonly ActivityEvent[] = [],
): OverlapRow[] {
  const names = new Map(flattenSessions(sessions).map(session => [session.sessionId, session.name]));
  const laneName = new Map(lanes.map(lane => [lane.id, lane.name]));
  const open = new Map(lanes.filter(lane => lane.open).map(lane => [lane.id, lane]));
  const latest = new Map<string, string[]>();
  for (const event of events) {
    const command = event.command;
    if (command.kind !== 'change' || !command.laneId || !command.paths || latest.has(command.laneId))
      continue;
    if (open.has(command.laneId)) latest.set(command.laneId, command.paths);
  }
  return overlapRows(
    [...latest].map(([laneId, paths]) => ({ lane: open.get(laneId)!, paths: paths.map(path => ({ path })) })),
    claims.map(claim => ({
      owner: claim.sessionId ?? claim.actor,
      label:
        (claim.sessionId && names.get(claim.sessionId)) ||
        (claim.laneId && laneName.get(claim.laneId)) ||
        'A participant',
      paths: claim.paths,
      ...(claim.laneId ? { laneId: claim.laneId } : {}),
      ...(claim.sessionId ? { recipient: claim.sessionId } : {}),
    })),
  );
}

const feedGlyph: Record<string, FeedItem['glyph']> = {
  change: 'sync',
  handoff: 'handoff',
  message: 'message',
  claim: 'claim',
  release: 'claim',
};
/** Related events without the per-session status chatter or acknowledgements. */
/** Plain-language verb for a server change event. */
function changeVerb(command: { source: string; action?: string; paths?: string[]; pathCount?: number }) {
  const files = command.pathCount ?? command.paths?.length;
  const verb =
    command.action ??
    (command.source === 'exchange' ? 'pushed' : command.source === 'return' ? 'returned source' : 'changed');
  return files ? `${verb} · ${files} ${files === 1 ? 'file' : 'files'}` : verb;
}

/** Related events, led by the Lane they concern, without status chatter or acknowledgements. */
export function hostedFeed(
  events: readonly ActivityEvent[],
  sessions: readonly Session[],
  lanes: readonly { id: string; name: string }[] = [],
  limit = 10,
): FeedItem[] {
  const laneName = new Map(lanes.map(lane => [lane.id, lane.name]));
  return events
    .filter(event => event.command.kind !== 'activity' && event.command.kind !== 'ack')
    .slice(0, limit)
    .map(event => {
      const command = event.command;
      const laneId =
        'laneId' in command ? command.laneId : 'context' in command ? command.context.laneId : undefined;
      const lane = (laneId && laneName.get(laneId)) || undefined;
      const who = activityAuthor(event, [...sessions]);
      let text: string, detail: string | undefined;
      switch (command.kind) {
        case 'change':
          text = `${lane ?? (command.action === 'accept' ? 'main' : 'Project')} · ${changeVerb(command)}`;
          detail = [command.head?.slice(0, 7), command.paths?.slice(0, 3).join(', ')]
            .filter(Boolean)
            .join(' · ');
          break;
        case 'claim':
          text = `${who} claimed ${command.paths.length} ${command.paths.length === 1 ? 'path' : 'paths'}${lane ? ` for ${lane}` : ''}`;
          detail = command.paths.slice(0, 3).join(', ');
          break;
        case 'release':
          text = `${who} released a claim`;
          break;
        case 'handoff':
          text = `${who} handed off ${lane ?? 'work'}`;
          detail = command.summary;
          break;
        default:
          text = `${who} → ${event.recipientActor ? 'you' : 'everyone'}${lane ? ` · ${lane}` : ''}`;
          detail = eventText(event);
      }
      return {
        id: event.operationId,
        at: event.at,
        tone: command.kind === 'change' ? 'active' : command.kind === 'handoff' ? 'waiting' : 'plain',
        glyph: feedGlyph[command.kind] ?? 'message',
        text,
        ...(detail ? { detail } : {}),
        ...(laneId ? { laneId } : {}),
      };
    });
}
