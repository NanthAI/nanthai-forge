import { ErrorToast } from '../ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { PagedList } from './ScaleList';
import { SCALE_AFTER } from './scale-model';
import { flattenSessions } from '../coordination-view';
import { MessageComposer } from '../lane/MessageComposer';
import type { CoordinationCommand } from '../../../src/coordination-types';
import { Menu } from '../ui/Menu';
import { COORDINATION_STALE_MS } from '../../../src/coordination-types';
import { activityAt, presenceState } from '../../../src/presence';
import { WorkText } from './WorkReferences';
import { sessionTreeRows } from './session-tree';
import { Component, useState, type ReactNode } from 'react';
import { isPersonSession, type Session } from '../coordination-view';
import { Glyph } from '../ui/Glyph';
import { Avatar, Dot, Panel } from '../ui/primitives';
import { age, freshness, seenAt, toneLabel } from '../ui/status';

/**
 * People and agents reporting work, freshest first: their own last words, tool and machine, who
 * started them. "Last seen" is a receipt time, never "online". Sessions not seen recently fold away;
 * after PRESENCE.hideMs, or once their Lane ends, they leave this panel (Activity keeps them).
 */
export function Sessions({
  sessions,
  now,
  loading,
  laneName,
  laneHref,
  viewer,
  endedLaneIds,
  send,
  unanswered = new Map(),
}: {
  unanswered?: ReadonlyMap<string, number>;
  send?: (command: CoordinationCommand) => Promise<unknown>;
  sessions: readonly Session[];
  now: number;
  loading?: boolean;
  laneName: (laneId: string) => string | undefined;
  laneHref?: (laneId: string) => string;
  viewer?: string;
  endedLaneIds?: readonly string[];
}) {
  const [compose, setCompose] = useState<{ session: Session; kind: 'message' | 'handoff' } | null>(null);
  const [showStale, setShowStale] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const keep = new Set([...unanswered].filter(([, count]) => count > 0).map(([id]) => id));
  const tree = sessionTreeRows(sessions, now, showStale, endedLaneIds, keep);
  const newest = tree.folded.reduce((max, session) => Math.max(max, activityAt(session)), 0);
  const label = (session: Session) => {
    const state = presenceState(session, now);
    const seen =
      state === 'not-seen'
        ? `not seen since ${seenAt(activityAt(session), now)}`
        : `${state === 'quiet' ? 'quiet' : session.status === 'waiting' ? 'waiting' : 'working'} · ${age(activityAt(session), now)}`;
    return seen;
  };
  /** Message · Hand off · Open Lane, behind ⋯ so the seen cell never wraps. */
  const actions = (session: Session, name: string) => {
    const lane = session.context.laneId;
    return (
      <Menu
        label={<Glyph name="more" size={14} />}
        className="fx-icon-btn fx-person-more"
        ariaLabel={`Actions for ${name}`}
      >
        <button type="button" onClick={() => setCompose({ session, kind: 'message' })}>
          <Glyph name="message" size={14} /> Message
        </button>
        <button type="button" onClick={() => setCompose({ session, kind: 'handoff' })}>
          <Glyph name="handoff" size={14} /> Hand off
        </button>
        {lane && laneHref && (
          <a href={laneHref(lane)}>
            <Glyph name="lane" size={14} /> Open Lane
          </a>
        )}
      </Menu>
    );
  };
  const overlaps = (session: Session) => {
    const count = unanswered.get(session.sessionId) ?? 0;
    return (
      count > 0 && (
        <div className="fx-person-overlaps">
          <Glyph name="overlap" size={12} />
          <a
            href="#fx-overlaps"
            title="Overlap alerts delivered to this agent's Lane and not yet acknowledged or routed around. Its next edit of those files waits for its answer."
          >
            {count} {count === 1 ? 'overlap' : 'overlaps'} unanswered
          </a>
        </div>
      )
    );
  };
  const children = (session: Session): ReactNode =>
    (session.subagents ?? []).length > 0 && (
      <div className="fx-session-children" aria-label={`${session.name}'s subagents`}>
        <PagedList
          className="fx-subagents"
          rows={session.subagents!}
          size={5}
          render={child => (
            <li
              key={child.sessionId}
              className={`fx-subagent fx-person-${freshness(activityAt(child), now, child.status)}`}
            >
              <Dot tone={freshness(activityAt(child), now, child.status)} />
              <span className="fx-subagent-name">{child.name}</span>
              <span className="fx-subagent-doing">
                <WorkText text={child.summary} />
              </span>
              <span className="fx-person-seen" title={new Date(activityAt(child)).toLocaleString()}>
                {label(child)}
              </span>
              {overlaps(child)}
              {actions(child, child.name)}
              {children(child)}
            </li>
          )}
        />
      </div>
    );
  const row = (session: Session) => {
    const tone =
      keep.has(session.sessionId) &&
      (session.status === 'completed' || now - session.lastSeen > COORDINATION_STALE_MS)
        ? 'stale'
        : freshness(activityAt(session), now, session.status);
    const name =
      !session.name.trim() ||
      /^agent workflow$/i.test(session.name.trim()) ||
      /^(user_|contributor_)/.test(session.name)
        ? '—'
        : session.name;
    const lane = session.context.laneId;
    const person = isPersonSession(session);
    const title = lane ? laneName(lane) : undefined;
    const summary = (title ? session.summary.replaceAll(title, '') : session.summary)
      .replace(/^start:\s*/i, '')
      .replace(/^[\s·:—–-]+|[\s·:—–-]+$/g, '');
    const words = (value: string) => value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const titleWords = new Set(words(title ?? ''));
    const summaryWords = words(summary);
    const repeatsTitle =
      summaryWords.length > 3 &&
      summaryWords.filter(word => titleWords.has(word)).length / summaryWords.length > 0.7;
    const own = Boolean(summary) && !repeatsTitle;
    const activity = own ? summary : (session.activityKind?.replaceAll('-', ' ') ?? toneLabel[tone]);
    const starter = !person && (session.actor === viewer ? 'you' : (session.actorDisplayName ?? undefined));
    const where = [title && `Lane: ${title}`, session.summary].filter(Boolean).join('\n');
    return (
      <li key={session.sessionId} className={`fx-person fx-person-${tone}`}>
        <Avatar name={name} identity={session.sessionId} kind={person ? 'human' : 'agent'} />
        <div className="fx-person-main" title={starter && starter !== 'you' ? `started by ${starter}` : ''}>
          <div className="fx-person-name">
            {name}
            {session.actorFormerMember && <span className="fx-faint">former member</span>}
            {!person && <span className="fx-agent-tag">agent</span>}
          </div>
          <div className="fx-person-doing">
            <span className="fx-person-activity" title={where}>
              {own ? (
                <q>
                  <WorkText text={activity} />
                </q>
              ) : (
                <WorkText text={activity} />
              )}
            </span>
          </div>
          {overlaps(session)}
        </div>
        <span className="fx-person-seen" title={new Date(activityAt(session)).toLocaleString()}>
          <Dot tone={tone} />
          {keep.has(session.sessionId)
            ? age(activityAt(session), now)
                .replace(' min', 'm')
                .replace(' h', 'h')
                .replace(' s', 's')
                .replace(' d', 'd')
            : label(session)}
        </span>
        {actions(session, name)}
        {children(session)}
      </li>
    );
  };
  const observed = flattenSessions(tree.visible);
  const people = observed.filter(isPersonSession).length;
  return (
    <Panel title="Who's working" count={tree.listed} labelId="fx-who">
      {compose && <MessageComposer {...compose} {...(send ? { send } : {})} close={() => setCompose(null)} />}
      {loading ? (
        <p className="fx-loading" role="status">
          Reading sessions…
        </p>
      ) : tree.total === 0 ? (
        <div className="fx-allclear">
          <b>No one yet.</b>
        </div>
      ) : tree.total > SCALE_AFTER ? (
        <>
          <div className="fx-scale-totals">
            <span>
              <b>{observed.length - people}</b> agents
            </span>
            <span>
              <b>{people}</b> people
            </span>
          </div>
          <PagedList rows={tree.visible} render={row} className="fx-people" size={5} />
        </>
      ) : (
        <ul className="fx-people">{(showAll ? tree.visible : tree.visible.slice(0, 5)).map(row)}</ul>
      )}
      {((tree.total <= SCALE_AFTER && tree.visible.length > 5) || tree.folded.length > 0) && (
        <div className="fx-fold">
          {tree.total <= SCALE_AFTER && tree.visible.length > 5 && (
            <button type="button" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Show fewer' : `${tree.visible.length - 5} more working`}
            </button>
          )}
          {tree.folded.length > 0 && (
            <button
              type="button"
              className="fx-fold-quiet"
              aria-expanded={showStale}
              onClick={() => setShowStale(!showStale)}
            >
              {tree.total <= SCALE_AFTER && tree.visible.length > 5 && '· '}
              {`${showStale ? 'Hide ' : ''}${tree.folded.length} not seen since ${seenAt(newest, now)}`}
            </button>
          )}
        </div>
      )}
    </Panel>
  );
}

/** Keeps the rest of a screen usable when one live panel cannot read its data. */
export class PanelBoundary extends Component<{ title: string; children: ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : 'Unavailable.' };
  }
  render() {
    return this.state.error ? (
      <Panel title={this.props.title}>
        <ErrorToast
          error={`Could not load ${this.props.title}.`}
          retry={() => this.setState({ error: '' })}
        />
      </Panel>
    ) : (
      this.props.children
    );
  }
}
