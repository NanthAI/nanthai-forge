// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { PlanningItem, PlanningWrite } from '../../../src/work-planning-types';
import type { PlanningAct, PlanningData } from '../WorkPlanning';
import {
  childInitiatives,
  initiativeProgress,
  initiativeRows,
  initiativeTimeline,
  planningGroups,
  planningRowMatches,
  type PlanningRow,
} from '../planning-rows';
import { WorkDetailLayout, CollapseSideButton } from '../shell/WorkDetailLayout';
import { Glyph } from '../ui/Glyph';
import { Menu } from '../ui/Menu';
import { Avatar, Button, Panel, StatusPill } from '../ui/primitives';
import { WorkRow } from '../ui/WorkRow';
import { age } from '../ui/status';
import './initiative.css';

export function PlanningRowFact({ row }: { row: PlanningRow }) {
  return (
    <>
      <span>{row.fact}</span>
      {row.actor && (
        <span className="fx-wr-who">
          <Avatar name={row.actor.name} kind={row.actor.kind === 'agent' ? 'agent' : 'human'} size="sm" />
          by {row.actor.name}
        </span>
      )}
    </>
  );
}

export function InitiativeConversation({
  itemId,
  data,
  act,
  busy,
  readOnly,
  commentContent,
  authorLabel = '',
}: {
  itemId: string;
  authorLabel?: string;
  data: PlanningData;
  act: PlanningAct;
  busy: boolean;
  readOnly?: boolean;
  commentContent?: (comment: PlanningData['planningComments'][number]) => ReactNode;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const pending = useRef<PlanningWrite | null>(null);
  const submitting = useRef(false);
  const comments = data.planningComments.filter(comment => comment.itemId === itemId);
  const confirmed = comments.some(comment => comment.id === pending.current?.operationId);
  useEffect(() => {
    if (confirmed) {
      pending.current = null;
      setText('');
    }
  }, [confirmed]);
  async function send(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    const command = pending.current ?? {
      action: 'comment-planning-item' as const,
      operationId: crypto.randomUUID(),
      itemId,
      text,
      authorLabel,
    };
    pending.current = command;
    submitting.current = true;
    setSending(true);
    setError('');
    try {
      const ack = await act(command);
      if (ack?.operationId === command.operationId && pending.current?.operationId === command.operationId) {
        pending.current = null;
        setText('');
      }
    } catch (error) {
      setError((error as Error).message);
    } finally {
      submitting.current = false;
      setSending(false);
    }
  }
  return (
    <Panel title="Conversation" count={comments.length}>
      {comments.map(comment => (
        <div className="fx-msg" key={comment.id}>
          {commentContent ? (
            commentContent(comment)
          ) : (
            <>
              <div className="fx-msg-head">
                {comment.authorLabel && (
                  <>
                    <Avatar name={comment.authorLabel} size="sm" />
                    <b>{comment.authorLabel}</b>
                  </>
                )}
                <time title={comment.at}>{age(comment.at, Date.now())}</time>
              </div>
              <p>{comment.text}</p>
            </>
          )}
        </div>
      ))}
      {!readOnly && (
        <form className="fx-compose" onSubmit={send}>
          <input
            aria-label="Add to the conversation"
            placeholder="Add to the conversation…"
            required
            value={text}
            onChange={event => {
              setText(event.target.value);
              pending.current = null;
            }}
          />
          <Button size="sm" type="submit" disabled={busy || sending || !text.trim()}>
            Send
          </Button>
        </form>
      )}
      {error && (
        <p className="fx-feedback-error" role="alert">
          {error}
        </p>
      )}
    </Panel>
  );
}

export function InitiativePage({
  item,
  data,
  readOnly,
  busy,
  href,
  listHref,
  onCreate,
  onEdit,
  onStatus,
  onExport,
  editor,
  body,
  conversation,
  timelineData,
  origin = item,
}: {
  item: PlanningItem;
  data: PlanningData;
  readOnly?: boolean;
  busy: boolean;
  href: (kind: 'intent' | 'planning' | 'initiative', id: string) => string;
  listHref: string;
  onCreate: (kind: PlanningItem['kind'], parent: string) => void;
  onEdit: () => void;
  onStatus: (status: PlanningItem['status']) => void;
  onExport: () => void;
  editor?: ReactNode;
  body?: ReactNode;
  conversation: ReactNode;
  timelineData?: PlanningData;
  origin?: PlanningItem;
}) {
  const [copyError, setCopyError] = useState('');
  const groups = planningGroups(data.planningItems, data.intents, data.lanes ?? []);
  const rows = initiativeRows(groups.find(group => group.id === item.id)?.rows ?? []);
  const progress = initiativeProgress(item, rows);
  const children = childInitiatives(data.planningItems, item.id);
  const parent = data.planningItems.find(value => value.id === item.initiativeId);
  const timeline = initiativeTimeline(
    origin,
    rows,
    (timelineData ?? data).intents,
    (timelineData ?? data).lanes ?? [],
  );
  const tone = progress.label === 'Done' ? 'passed' : progress.label === 'In motion' ? 'active' : 'plain';
  const rowHref = (row: PlanningRow) =>
    href(row.intentId ? 'intent' : 'planning', row.intentId ?? row.itemId!);
  const addIntent = () => onCreate('issue', item.id);
  const edit = !readOnly && (
    <button className="fx-act" onClick={onEdit}>
      Edit
    </button>
  );
  const pill = (
    <StatusPill tone={tone}>
      {progress.label}
      <Glyph name="down" size={10} />
    </StatusPill>
  );
  return (
    <WorkDetailLayout
      className="fx fx-initiative planning-board"
      timelineCount={timeline.length}
      messageCount={data.planningComments.filter(comment => comment.itemId === item.id).length}
      crumbs={
        <nav className="fx-crumbs" aria-label="Breadcrumb">
          <a href={listHref}>Work</a>
          <span>›</span>
          <a href={listHref}>
            <Glyph name="initiative" size={12} />
            Planning
          </a>
          <span>›</span>
          <a href={href('initiative', item.id)} aria-current="page">
            <Glyph name="initiative" size={12} />
            {item.title}
          </a>
        </nav>
      }
      header={
        <header className="fx-lane-head">
          <div className="fx-lane-head-main">
            <h1>
              <Glyph name="initiative" size={20} />
              {item.title}{' '}
              {readOnly ? (
                pill
              ) : (
                <Menu ariaLabel="Initiative status" className="fx-initiative-status" label={pill}>
                  {item.status === 'closed' ? (
                    <button disabled={busy} onClick={() => onStatus('open')}>
                      Reopen
                    </button>
                  ) : (
                    <>
                      <button disabled>Planned</button>
                      <button disabled title="starts with the first Lane">
                        In motion
                      </button>
                      <button disabled={busy} onClick={() => onStatus('closed')}>
                        Mark done
                      </button>
                      <hr />
                      <button disabled title="Initiatives have no abandoned state">
                        Abandon…
                      </button>
                    </>
                  )}
                </Menu>
              )}
            </h1>
            <div className="fx-lane-meta">
              <span className="fx-initiative-progress">
                <span className="fx-initiative-bar" aria-hidden="true">
                  {rows.map((row, index) => (
                    <i
                      key={row.id}
                      className={
                        index < progress.done
                          ? 'done'
                          : index < progress.done + progress.motion
                            ? 'motion'
                            : ''
                      }
                    />
                  ))}
                </span>
                {progress.done} of {progress.total} done · {progress.motion} in motion
              </span>
              {parent && (
                <a href={href('initiative', parent.id)}>
                  <Glyph name="initiative" size={12} />
                  {parent.title}
                </a>
              )}
              {origin.version === 1 && (
                <span className="fx-initiative-created">
                  created <time title={origin.at}>{age(origin.at, Date.now(), true)}</time>
                </span>
              )}
            </div>
          </div>
          {!readOnly && (
            <div className="fx-lane-head-actions">
              <Button icon="plus" onClick={addIntent}>
                Add Intent
              </Button>
              <Button variant="ghost" onClick={onEdit}>
                Edit
              </Button>
              <Menu label="⋯" ariaLabel="More Initiative actions">
                <button
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(location.href)
                      .catch(error => setCopyError((error as Error).message));
                  }}
                >
                  Copy link
                </button>
                <button onClick={onExport}>Export</button>
                <button disabled title="Initiatives have no abandoned state">
                  Abandon…
                </button>
              </Menu>
            </div>
          )}
        </header>
      }
      side={
        <>
          <Panel title="Timeline" count={timeline.length} actions={<CollapseSideButton />}>
            <ol className="fx-feed">
              {timeline.map(event => (
                <li key={event.id}>
                  <time className="fx-feed-time" title={event.at}>
                    {age(event.at, Date.now())}
                  </time>
                  <Glyph
                    name={event.glyph}
                    size={13}
                    className={event.glyph === 'passed' ? 'fx-c-passed' : ''}
                  />
                  <div>
                    <div className="fx-feed-text">{event.label}</div>
                    {event.detail && (
                      <div className="fx-feed-detail">
                        <a
                          href={
                            event.intentId
                              ? href('intent', event.intentId)
                              : event.itemId
                                ? href('planning', event.itemId)
                                : href('initiative', item.id)
                          }
                        >
                          {event.detail}
                        </a>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </Panel>
          {conversation}
        </>
      }
    >
      {copyError && (
        <p role="alert" className="fx-feedback-error">
          {copyError}
        </p>
      )}
      <Panel title="Details" actions={edit}>
        {editor || <div className="fx-initiative-body">{body ?? <p>{item.body}</p>}</div>}
      </Panel>
      <Panel
        title="Intents"
        count={rows.length}
        actions={
          !readOnly && (
            <button className="fx-act" onClick={addIntent}>
              Add Intent
            </button>
          )
        }
      >
        <ul className="fx-wrs">
          {rows.map(row => (
            <WorkRow
              key={row.id}
              title={row.title}
              href={rowHref(row)}
              tone={row.tone}
              label={row.label}
              fact={<PlanningRowFact row={row} />}
              age={row.at && <time title={row.at}>{age(row.at, Date.now())}</time>}
              done={planningRowMatches(row, 'done')}
            />
          ))}
        </ul>
      </Panel>
      <Panel
        title="Child Initiatives"
        count={children.length}
        actions={
          !readOnly && (
            <button className="fx-act" onClick={() => onCreate('initiative', item.id)}>
              New Initiative
            </button>
          )
        }
      >
        {children.map(child => {
          const own = groups.find(group => group.id === child.id)?.rows ?? [];
          const state = initiativeProgress(child, own);
          return (
            <div className="planning-grp" key={child.id}>
              <a className="planning-group-title" href={href('initiative', child.id)}>
                <Glyph name="initiative" size={16} />
                {child.title}
              </a>
              <span className="planning-group-count">
                {own.length} {own.length === 1 ? 'Intent' : 'Intents'}
              </span>
              <StatusPill
                tone={state.label === 'Done' ? 'passed' : state.label === 'In motion' ? 'active' : 'plain'}
              >
                {state.label}
              </StatusPill>
            </div>
          );
        })}
      </Panel>
    </WorkDetailLayout>
  );
}
