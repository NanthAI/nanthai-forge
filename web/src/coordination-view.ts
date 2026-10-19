// SPDX-License-Identifier: Apache-2.0
import type { Doc } from '../../convex/_generated/dataModel';
import { commandScope } from '../../src/coordination-paths';
import { COORDINATION_STALE_MS } from '../../src/coordination-types';
export type Session = Omit<
  Doc<'projectCoordinationSessions'>,
  '_id' | '_creationTime' | 'projectId' | 'operationId' | 'sequence'
> & {
  sequence?: number;
  /** Display children are reconstructed from flat pages; legacy callers may supply nested trees. */
  subagents?: Session[];
};
/** Build display trees from bounded flat pages, keeping children whose parent is not loaded. */
export function sessionForest(rows: readonly Session[]): Session[] {
  const nodes = new Map(rows.map(row => [row.sessionId, { ...row, subagents: [] as Session[] }]));
  const roots: Session[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentSessionId ? nodes.get(node.parentSessionId) : undefined;
    if (parent) parent.subagents.push(node);
    else roots.push(node);
  }
  return roots;
}
/** Every session in a tree, roots first, each followed by its subagents. */
export function flattenSessions(roots: readonly Session[]): Session[] {
  return roots.flatMap(root => [root, ...flattenSessions(root.subagents ?? [])]);
}
/** People's own editor sessions; older sessions without a kind count as one when named after their person. */
export function isPersonSession(session: Session): boolean {
  return session.kind
    ? session.kind === 'person'
    : Boolean(session.actorDisplayName) && session.name === session.actorDisplayName;
}
export type ActivityEvent = Doc<'projectCoordinationEvents'>;
export type WorkLabels = {
  intents: { id: string; outcome: string }[];
  lanes: { id: string; name: string; intentId: string }[];
};
export function contextLabels(context: { intentId?: string; laneId?: string }, labels: WorkLabels) {
  const lane = labels.lanes.find(item => item.id === context.laneId),
    intentId = context.intentId ?? lane?.intentId;
  return {
    intent:
      labels.intents.find(item => item.id === intentId)?.outcome ??
      (intentId ? 'Linked Intent' : context.laneId ? 'Intent not loaded' : 'Project-wide'),
    lane: lane?.name ?? (context.laneId ? 'Linked Lane' : ''),
  };
}
export function eventContext(event: ActivityEvent, events: ActivityEvent[]) {
  if (event.command.kind !== 'ack') return commandScope(event.command);
  const messageId = event.command.messageId;
  const message = events.find(item => item.operationId === messageId);
  return message && message.command.kind !== 'ack' ? commandScope(message.command) : {};
}
const KIND_LABELS: Record<string, string> = {
  activity: 'Session update',
  message: 'Message',
  ack: 'Acknowledgement',
  claim: 'Claim',
  release: 'Released claim',
  handoff: 'Handoff',
  change: 'Related change',
};
export const eventKindLabel = (event: ActivityEvent) => KIND_LABELS[event.command.kind] ?? 'Event';
/** One line describing an event, whatever its kind. */
export function eventText(event: ActivityEvent) {
  const command = event.command;
  switch (command.kind) {
    case 'activity':
    case 'handoff':
      return command.summary;
    case 'message':
    case 'ack':
      return command.text;
    case 'claim':
      return `${command.paths.join(', ')}${command.note ? ` — ${command.note}` : ''}`;
    case 'release':
      return `Claim ${command.claimId}`;
    case 'change': {
      const what = command.source === 'work' ? (command.action ?? 'Work') : command.source;
      const files = command.paths?.length
        ? ` · ${command.paths.slice(0, 3).join(', ')}${(command.pathCount ?? 0) > 3 ? ` +${(command.pathCount ?? 0) - 3}` : ''}`
        : '';
      return `${what}${command.head ? ` at ${command.head.slice(0, 12)}` : ''}${files}`;
    }
  }
}
export function activityAuthor(event: ActivityEvent, sessions: Session[]) {
  const sessionId = 'sessionId' in event.command ? event.command.sessionId : undefined;
  const session = sessionId && flattenSessions(sessions).find(item => item.sessionId === sessionId);
  const declared =
    event.command.kind === 'message' && !sessionId
      ? event.command.text.match(/^\s*((?:gpt|claude|codex|gemini)-[\w-]+)\s*:/i)?.[1]
      : undefined;
  const name =
    event.command.kind === 'activity'
      ? event.command.name
      : session
        ? session.name
        : (declared ?? event.actorDisplayName ?? 'Project participant');
  return event.actorFormerMember ? `${name} · former member` : name;
}
/** Last-seen age label; a report is a receipt time, never proof the agent is running. */
export function lastSeenLabel(lastSeen: number, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - lastSeen) / 1000));
  const age =
    seconds < 60
      ? `${seconds}s`
      : seconds < 3600
        ? `${Math.round(seconds / 60)}m`
        : `${Math.round(seconds / 3600)}h`;
  return { label: `last seen ${age} ago`, stale: now - lastSeen > COORDINATION_STALE_MS };
}
export function sessionRows(
  sessions: Session[],
  labels: WorkLabels,
  search: string,
  status: string,
  sort: string,
  intentId?: string,
  laneId?: string,
) {
  const query = search.trim().toLowerCase();
  return sessions
    .filter(
      item =>
        inActivityScope(item.context, labels, intentId, laneId) &&
        (status === 'all' || item.status === status) &&
        [
          item.name,
          item.summary,
          item.environment,
          ...Object.values(contextLabels(item.context, labels)),
          ...(item.context.paths ?? []),
        ]
          .join(' ')
          .toLowerCase()
          .includes(query),
    )
    .sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name)
        : sort === 'oldest'
          ? a.lastSeen - b.lastSeen
          : b.lastSeen - a.lastSeen,
    );
}
export function eventRows(
  events: ActivityEvent[],
  sessions: Session[],
  labels: WorkLabels,
  search: string,
  kind: string,
  sort: string,
  intentId?: string,
  laneId?: string,
) {
  const query = search.trim().toLowerCase();
  return events
    .filter(
      item =>
        inActivityScope(eventContext(item, events), labels, intentId, laneId) &&
        (kind === 'all' || item.command.kind === kind) &&
        [
          activityAuthor(item, sessions),
          eventText(item),
          ...Object.values(contextLabels(eventContext(item, events), labels)),
        ]
          .join(' ')
          .toLowerCase()
          .includes(query),
    )
    .sort((a, b) => (sort === 'oldest' ? a.at - b.at : b.at - a.at));
}

export function inActivityScope(
  context: { intentId?: string; laneId?: string },
  labels: WorkLabels,
  intentId?: string,
  laneId?: string,
) {
  const parent = context.intentId ?? labels.lanes.find(lane => lane.id === context.laneId)?.intentId;
  return (!laneId || context.laneId === laneId) && (!intentId || parent === intentId);
}
export function activityLink(
  projectId: string,
  context: { intentId?: string; laneId?: string },
  recordId?: string,
  tab = 'sessions',
) {
  const params = new URLSearchParams({ surface: 'projects', collection: 'projects', project: projectId });
  if (context.laneId) {
    params.set('projectTab', 'lanes');
    params.set('lane', context.laneId);
    params.set('laneTab', 'activity');
  } else if (context.intentId) {
    params.set('projectTab', 'intent');
    params.set('intent', context.intentId);
    params.set('intentTab', 'coordination');
  } else params.set('projectTab', 'coordination');
  if (recordId) {
    params.set('session', recordId);
    params.set('activityTab', tab);
  }
  return `?${params}`;
}
