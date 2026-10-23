import { ErrorToast } from './ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { WorkStatus } from './WorkStatus';
import { WorkTimeline } from './WorkTimeline';
import { useEffect, useState } from 'react';
import { useMutation, usePaginatedQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import type { PaginationOptions, PaginationResult } from 'convex/server';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import type { CoordinationCommand } from '../../src/coordination-types';
import { hostedError } from './snapshot';
import { ActionPanel, PageTabs, useDestination, useSection, Icon } from './WorkspaceUI';
import {
  activityAuthor,
  activityLink,
  inActivityScope,
  contextLabels,
  eventContext,
  eventKindLabel,
  eventRows,
  eventText,
  lastSeenLabel,
  sessionRows,
  type WorkLabels,
} from './coordination-view';

type PageArgs = { projectId: Id<'hostedProjects'>; paginationOpts: PaginationOptions };
const sessionsRef = makeFunctionReference<
  'query',
  PageArgs,
  PaginationResult<Doc<'projectCoordinationSessions'>>
>('projectCoordination:sessions');
const eventsRef = makeFunctionReference<
  'query',
  PageArgs,
  PaginationResult<Doc<'projectCoordinationEvents'>>
>('projectCoordination:recent');
const publishRef = makeFunctionReference<
  'mutation',
  { projectId: Id<'hostedProjects'>; operationId: string; command: CoordinationCommand },
  Doc<'projectCoordinationEvents'>
>('projectCoordination:publish');
function stamp(at: number) {
  return new Date(at).toLocaleString();
}
export default function ProjectCoordination({
  projectId,
  labels = { intents: [], lanes: [] },
  scopeIntentId,
  scopeLaneId,
  active = true,
  openIntent,
}: {
  projectId: Id<'hostedProjects'>;
  labels?: WorkLabels;
  scopeIntentId?: string;
  scopeLaneId?: string;
  active?: boolean;
  openIntent?: (id: string) => void;
}) {
  const sessions = usePaginatedQuery(sessionsRef, { projectId }, { initialNumItems: 20 });
  const events = usePaginatedQuery(eventsRef, { projectId }, { initialNumItems: 30 });
  const publish = useMutation(publishRef);
  const [tab, setTab] = useSection('activityTab', ['sessions', 'events'] as const, 'sessions'),
    [search, setSearch] = useState(''),
    [status, setStatus] = useState('all'),
    [kind, setKind] = useState('all'),
    [sort, setSort] = useState('newest');
  const [selected, setSelected] = useDestination('session'),
    [text, setText] = useState(''),
    [recipient, setRecipient] = useState('');
  const [intentId, setIntent] = useState(scopeIntentId ?? ''),
    [laneId, setLane] = useState(scopeLaneId ?? ''),
    [head, setHead] = useState('');
  const [pending, setPending] = useState<{
    projectId: Id<'hostedProjects'>;
    operationId: string;
    command: CoordinationCommand;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function send(command?: CoordinationCommand) {
    const original = pending ?? (command ? { projectId, operationId: crypto.randomUUID(), command } : null);
    if (!original) return;
    setPending(original);
    setBusy(true);
    setError('');
    try {
      await publish(original);
      setPending(null);
      if (original.command.kind === 'message') setText('');
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  }
  const rows = sessionRows(sessions.results, labels, search, status, sort, scopeIntentId, scopeLaneId),
    feed = eventRows(
      events.results,
      sessions.results,
      labels,
      search,
      kind,
      sort,
      scopeIntentId,
      scopeLaneId,
    );
  const session = tab === 'sessions' ? sessions.results.find(item => item.sessionId === selected) : undefined,
    event = tab === 'events' ? events.results.find(item => item.operationId === selected) : undefined;
  useEffect(() => {
    if (!selected) return;
    if (tab === 'sessions' && !session && sessions.status === 'CanLoadMore') sessions.loadMore(20);
    if (
      tab === 'events' &&
      (!event ||
        (event.command.kind === 'ack' &&
          !events.results.some(
            item => item.operationId === ('messageId' in event.command ? event.command.messageId : undefined),
          ))) &&
      events.status === 'CanLoadMore'
    )
      events.loadMore(30);
  }, [
    selected,
    tab,
    session,
    event,
    sessions.status,
    sessions.loadMore,
    events.status,
    events.loadMore,
    events.results,
  ]);
  const detailContext = session?.context ?? (event ? eventContext(event, events.results) : undefined);
  const recordHref = (context: { intentId?: string; laneId?: string }, id: string) =>
    (context.laneId && context.laneId !== scopeLaneId) || (context.intentId && !scopeIntentId && !scopeLaneId)
      ? activityLink(projectId, context, id, tab)
      : undefined;
  const relocation = detailContext ? recordHref(detailContext, selected) : undefined;
  useEffect(() => {
    if (active && relocation) window.location.replace(relocation);
  }, [active, relocation]);
  const linked = (context: { intentId?: string; laneId?: string }) => {
    const named = contextLabels(context, labels);
    return (
      <p className="activity-context">
        {context.laneId ? (
          <a href={activityLink(projectId, context)}>
            <Icon name="lane" />
            {named.lane}
          </a>
        ) : context.intentId ? (
          <a href={activityLink(projectId, context)}>
            <Icon name="intent" />
            {named.intent}
          </a>
        ) : (
          <span>Project-wide</span>
        )}
        {context.laneId && context.intentId && (
          <button className="text-button" onClick={() => openIntent?.(context.intentId!)}>
            {named.intent}
          </button>
        )}
      </p>
    );
  };
  const selectedInScope =
    !detailContext || inActivityScope(detailContext, labels, scopeIntentId, scopeLaneId);
  return (
    <section aria-label="Project activity" className="hosted-coordination">
      <div className="section-heading">
        <div>
          <h2>{scopeLaneId ? 'Lane activity' : scopeIntentId ? 'Intent activity' : 'Project activity'}</h2>
        </div>
        <ActionPanel title="New message">
          <form
            onSubmit={e => {
              e.preventDefault();
              void send({
                kind: 'message',
                text,
                ...(recipient ? { recipient } : {}),
                context: {
                  ...(intentId ? { intentId } : {}),
                  ...(laneId ? { laneId } : {}),
                  ...(head ? { head } : {}),
                },
              });
            }}
          >
            <label>
              Recipient
              <select value={recipient} onChange={e => setRecipient(e.target.value)}>
                <option value="">Everyone</option>
                {sessions.results.map(item => (
                  <option key={item.sessionId} value={item.sessionId}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Message
              <textarea required value={text} onChange={e => setText(e.target.value)} />
            </label>
            <label>
              Related Intent
              <select
                value={intentId}
                onChange={e => {
                  setIntent(e.target.value);
                  setLane('');
                }}
              >
                <option value="">Project-wide</option>
                {labels.intents.map(item => (
                  <option key={item.id} value={item.id}>
                    {item.outcome}
                  </option>
                ))}
                {intentId && !labels.intents.some(item => item.id === intentId) && (
                  <option value={intentId}>Linked Intent</option>
                )}
              </select>
            </label>
            <label>
              Related Lane
              <select value={laneId} onChange={e => setLane(e.target.value)}>
                <option value="">No specific Lane</option>
                {labels.lanes
                  .filter(item => !intentId || item.intentId === intentId)
                  .map(item => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                {laneId && !labels.lanes.some(item => item.id === laneId) && (
                  <option value={laneId}>Linked Lane</option>
                )}
              </select>
            </label>
            <ActionPanel title="Link by source or identifier">
              <label>
                Intent ID
                <input value={intentId} onChange={e => setIntent(e.target.value)} />
              </label>
              <label>
                Lane ID
                <input value={laneId} onChange={e => setLane(e.target.value)} />
              </label>
              <label>
                Source head
                <input value={head} onChange={e => setHead(e.target.value)} />
              </label>
            </ActionPanel>
            <button disabled={busy || !!pending || !text.trim()}>Send message</button>
          </form>
        </ActionPanel>
      </div>
      {error && <ErrorToast>{error}</ErrorToast>}
      {pending && (
        <p role="status">
          Message outcome is unconfirmed.{' '}
          <button disabled={busy} onClick={() => void send()}>
            Reconcile original message
          </button>
        </p>
      )}
      {selected ? (
        <>
          <button className="back-link" onClick={() => setSelected('')}>
            ← {tab === 'sessions' ? 'Sessions' : 'Events'}
          </button>
          {relocation && <p role="status">Opening activity in its work context…</p>}
          {session && selectedInScope && !relocation && (
            <article>
              <div className="section-heading">
                <h3>{session.name}</h3>
                <WorkStatus status={session.status} label={`Reported ${session.status}`} />
              </div>
              <p>{session.summary}</p>
              {linked(session.context)}
              <p>{session.environment}</p>
              <p>
                Last report {stamp(session.lastSeen)} ({lastSeenLabel(session.lastSeen).label}
                {lastSeenLabel(session.lastSeen).stale ? ', stale' : ''})
              </p>
              <p className="provenance">
                Status is the session's last announcement, not a live execution check.
              </p>
              {!!session.context.paths?.length && (
                <>
                  <h4>Files</h4>
                  <ul>
                    {session.context.paths.map(path => (
                      <li key={path}>{path}</li>
                    ))}
                  </ul>
                </>
              )}
              {!!session.context.dependsOn?.length && (
                <>
                  <h4>Related work</h4>
                  <ul>
                    {session.context.dependsOn.map(value => (
                      <li key={value}>{value}</li>
                    ))}
                  </ul>
                </>
              )}
              <ActionPanel title="Technical references">
                <p>
                  Session <code>{session.sessionId}</code>
                </p>
                <p>
                  Authenticated actor <code>{session.actor}</code>
                </p>
                <p>
                  Intent <code>{session.context.intentId ?? 'Unspecified'}</code> · Lane{' '}
                  <code>{session.context.laneId ?? 'Unspecified'}</code>
                </p>
                <p>
                  Source <code>{session.context.head ?? 'Unknown'}</code> · sequence {session.sequence}
                </p>
                <p>Names, files and dependencies are supplied observations.</p>
              </ActionPanel>
            </article>
          )}
          {event && selectedInScope && !relocation && (
            <article>
              <h3>{eventKindLabel(event)}</h3>
              <p>
                {activityAuthor(event, sessions.results)} · {stamp(event.at)}
              </p>
              <p>{eventText(event)}</p>
              {linked(eventContext(event, events.results))}
              {event.command.kind === 'message' && (
                <>
                  <p>
                    To{' '}
                    {event.command.recipient
                      ? (sessions.results.find(
                          item =>
                            item.sessionId ===
                            ('recipient' in event.command ? event.command.recipient : undefined),
                        )?.name ?? 'Selected session')
                      : 'everyone'}
                  </p>
                  {!event.command.recipient && (
                    <button
                      disabled={busy || !!pending}
                      onClick={() =>
                        void send({
                          kind: 'ack',
                          messageId: event.operationId,
                          text: 'Acknowledged in the human cockpit',
                        })
                      }
                    >
                      Acknowledge
                    </button>
                  )}
                </>
              )}
              <ActionPanel title="Technical references">
                <p>
                  Operation <code>{event.operationId}</code>
                </p>
                <p>
                  Authenticated actor <code>{event.actor}</code>
                </p>
                {event.command.kind === 'ack' && (
                  <p>
                    Original message <code>{event.command.messageId}</code>
                  </p>
                )}
              </ActionPanel>
            </article>
          )}
          {((!session && !event) || !selectedInScope) && (
            <p role="status">
              {(tab === 'sessions' ? sessions : events).status === 'Exhausted'
                ? 'This activity is not available in this project. Return to the list to choose another item.'
                : 'Loading activity details…'}
            </p>
          )}
        </>
      ) : (
        <>
          <PageTabs
            label="Activity lists"
            value={tab}
            onChange={value => {
              setSelected('');
              setTab(value);
              if (value === 'events' && sort === 'name') setSort('newest');
            }}
            items={[
              { id: 'sessions', label: 'Sessions' },
              { id: 'events', label: 'Events & messages' },
            ]}
          />
          <div className="intent-filters">
            <label>
              Search activity
              <input type="search" value={search} onChange={e => setSearch(e.target.value)} />
            </label>
            {tab === 'sessions' ? (
              <label>
                Status
                <select value={status} onChange={e => setStatus(e.target.value)}>
                  <option value="all">All statuses</option>
                  {['working', 'waiting', 'observing', 'completed'].map(value => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
            ) : (
              <label>
                Event type
                <select value={kind} onChange={e => setKind(e.target.value)}>
                  <option value="all">All events</option>
                  <option value="activity">Session updates</option>
                  <option value="message">Messages</option>
                  <option value="ack">Acknowledgements</option>
                  <option value="claim">Claims</option>
                  <option value="handoff">Handoffs</option>
                  <option value="change">Related changes</option>
                </select>
              </label>
            )}
            <label>
              Sort
              <select value={sort} onChange={e => setSort(e.target.value)}>
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                {tab === 'sessions' && <option value="name">Name</option>}
              </select>
            </label>
          </div>
          <div className="activity-list">
            {tab === 'sessions' ? (
              rows.map(item => {
                const href = recordHref(item.context, item.sessionId),
                  named = contextLabels(item.context, labels);
                const content = (
                  <>
                    <small className="activity-owner">
                      <Icon
                        name={item.context.laneId ? 'lane' : item.context.intentId ? 'intent' : 'project'}
                      />
                      {named.lane || named.intent}
                      {named.lane && ` · ${named.intent}`}
                    </small>
                    <span className="activity-row-heading">
                      <strong>{item.name}</strong>
                      <WorkStatus status={item.status} label={`Reported ${item.status}`} />
                    </span>
                    <span className="activity-summary">{item.summary}</span>
                    <small>
                      {lastSeenLabel(item.lastSeen).label}
                      {lastSeenLabel(item.lastSeen).stale ? ' · stale' : ''}
                    </small>
                  </>
                );
                return href ? (
                  <a className="activity-row" key={item.sessionId} href={href}>
                    {content}
                  </a>
                ) : (
                  <button
                    className="activity-row"
                    key={item.sessionId}
                    onClick={() => setSelected(item.sessionId)}
                  >
                    {content}
                  </button>
                );
              })
            ) : (
              <WorkTimeline
                label="Events & messages"
                entries={feed.map(item => ({
                  id: item.operationId,
                  at: new Date(item.at).toISOString(),
                  kind: eventKindLabel(item),
                  title: activityAuthor(item, sessions.results),
                  detail: (
                    <div>
                      {eventText(item)}
                      {linked(eventContext(item, events.results))}
                    </div>
                  ),
                  href: recordHref(eventContext(item, events.results), item.operationId),
                  open: () => setSelected(item.operationId),
                }))}
              />
            )}
          </div>
          {(tab === 'sessions' ? sessions : events).status === 'LoadingFirstPage' ? (
            <p role="status">Loading activity…</p>
          ) : (
            !(tab === 'sessions' ? rows : feed).length && <p>No matching activity in the loaded records.</p>
          )}
          <p className="provenance">
            {tab === 'sessions' ? sessions.results.length : events.results.length} records loaded
            {(tab === 'sessions' ? sessions : events).status !== 'Exhausted'
              ? ' · filters apply to loaded records'
              : ''}
            .
          </p>
          {tab === 'sessions' && sessions.status === 'CanLoadMore' && (
            <button onClick={() => sessions.loadMore(20)}>Load more sessions</button>
          )}
          {tab === 'events' && events.status === 'CanLoadMore' && (
            <button onClick={() => events.loadMore(30)}>Load older events</button>
          )}
        </>
      )}
    </section>
  );
}
