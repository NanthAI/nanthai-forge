import { OwnerDecisionsPanel } from '../decisions/OwnerDecisionsPanel';
import { useOwnerDecisions } from '../decisions/context';
import { decisionTimeline } from '../decisions/model';
import { queueHref } from '../cockpit/queue-model';
import { useGenerationFreshness } from '../ui/generation-freshness';
// SPDX-License-Identifier: Apache-2.0
import { useState, type ReactNode } from 'react';
import { Menu } from '../ui/Menu';
import { ErrorToast } from '../ui/Toast';
import { ObjectActions } from '../shell/ObjectActions';
import { CopyPrompt } from '../cockpit/CopyPrompt';
import { clearDelegate, delegateRequested } from './useCreatedIntent';
import { canReviewView } from '../views/intent-views';
import { Combine } from '../views/Combine';
import { WorkMap } from '../views/WorkMap';
import { AddLane, AddLaneHandoff, Candidates, Conversation, CopyStartCommand, LaneTag } from './IntentParts';
import { WorkDetailLayout, CollapseSideButton } from '../shell/WorkDetailLayout';
import { WorkRow, LaneFactLine } from '../ui/WorkRow';
import { laneFacts } from '../ui/lane-facts';
import type { CockpitWork } from '../cockpit/model';
import type { TimelineEvent } from '../lane/timeline';
import { eventAnchor } from '../cockpit/Feed';
import { DetailsText } from '../ui/DetailsText';
import { Glyph } from '../ui/Glyph';
import { Button, ButtonLink, ExactRecord, Panel, StatusPill } from '../ui/primitives';
import { age } from '../ui/status';
import type { IntentRow, IntentStatus } from './model';
import '../views/views.css';
import './intents.css';

export type ViewRow = {
  queue?: import('../cockpit/queue-model').QueueFact;
  id: string;
  number?: number;
  changes?: NonNullable<CockpitWork['views'][number]['changes']>;
  status: 'clean' | 'conflict';
  at: string;
  lanes: string;
  check?: string;
  checkName?: string;
  checkHead?: string;
  accepted: boolean;
  acceptedAt?: string;
  head?: string;
  base?: string;
  supersededBy?: string | null;
  inputs?: { laneId: string; head: string; saveIndex?: number }[];
};
export type NoteRow = {
  text: string;
  kind: 'comment' | 'decision';
  at: string;
  actor?: { name: string; kind: 'agent' | 'human' };
  lane?: { id: string; name: string };
};
export type PlanRow = { id: string; kind: 'issue' | 'initiative'; title: string; status: string };

/** The Intent uses the Lane detail frame, with its merged activity in the same side column. */
export function IntentDetailView({
  row,
  views,
  notes,
  planning,
  now,
  laneHref,
  reviewHref,
  viewHref,
  combine,
  base,
  back,
  addLane,
  addNote,
  setStatus,
  more,
  records,
  timeline = [],
  activityMore,
  sendMessage,
  editHref,
  onEdit,
  editor,
  statusControl,
  meta,
  conversation,
  startIntentId = row.id,
  canStart = true,
}: {
  row: IntentRow;
  views: readonly ViewRow[];
  notes: readonly NoteRow[];
  planning: readonly PlanRow[];
  now: number;
  laneHref: (id: string) => string;
  reviewHref?: (id: string) => string;
  viewHref?: (id: string) => string;
  combine?: (inputs: { laneId: string; head: string }[]) => Promise<string | null>;
  base?: string;
  back?: ReactNode;
  addLane?: (name: string) => Promise<string | null>;
  addNote?: (text: string, kind: NoteRow['kind']) => Promise<string | null>;
  setStatus?: (status: Exclude<IntentStatus, 'proposed'>) => Promise<string | null>;
  more?: ReactNode;
  records?: CockpitWork;
  timeline?: readonly TimelineEvent[];
  activityMore?: ReactNode;
  sendMessage?: (text: string, laneId?: string) => Promise<string | null>;
  editHref?: string;
  onEdit?: () => void;
  editor?: ReactNode;
  statusControl?: ReactNode;
  meta?: ReactNode;
  conversation?: ReactNode;
  startIntentId?: string;
  canStart?: boolean;
}) {
  const ownerDecisions = useOwnerDecisions();
  timeline = [...timeline, ...decisionTimeline(ownerDecisions.records, row.id)].sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
  );
  const freshness = useGenerationFreshness();
  views = views.map(view => ({
    ...view,
    queue: row.lanes.find(lane => lane.queue?.viewId === view.id)?.queue,
  }));
  const [error, setError] = useState('');
  const [dismissed, setDismissed] = useState<string | null>(null);
  const run = async (action: Promise<string | null>) => {
    try {
      const problem = await action;
      setError(problem ?? '');
      return problem;
    } catch (error) {
      const message = (error as Error).message;
      setError(message);
      return message;
    }
  };
  const ready = [...views]
    .reverse()
    .find(
      view =>
        canReviewView(view) &&
        !row.lanes.some(lane => lane.queue && lane.queue.viewId === view.id && lane.queue.state !== 'review'),
    );
  const failed = row.open.find(lane => lane.queue?.state === 'failed');
  const queued = row.lanes.filter(
    lane => lane.queue && ['queued', 'checking', 'machine', 'dependency'].includes(lane.queue.state),
  ).length;
  const waitingForYou = row.lanes.filter(
    lane => lane.queue?.state === 'review' || lane.queue?.state === 'failed',
  ).length;
  const open = row.status === 'active' || row.status === 'ready';
  const checkedAt =
    ready &&
    records?.runs
      .filter(run => run.viewId === ready.id && run.head === ready.head && run.status === 'passed')
      .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''))[0]?.endedAt;
  const facts = records ? laneFacts(records, row.lanes, now, freshness.value !== null) : new Map();
  // Hosted copies can lag the owner machine; don't count unsynced completions as not landed.
  const unsynced = [...facts.values()].filter(fact => fact.text === 'Completed on owner machine').length;
  const details = (
    <Panel
      title="Details"
      actions={
        onEdit ? (
          <Button variant="ghost" size="sm" icon="pencil" onClick={onEdit}>
            Edit
          </Button>
        ) : (
          editHref && (
            <ButtonLink variant="ghost" size="sm" icon="pencil" href={editHref}>
              Edit
            </ButtonLink>
          )
        )
      }
    >
      {editor ?? (
        <>
          {row.constraints && row.constraints !== row.outcome && (
            <div className="fx-intent-why">
              <DetailsText text={row.constraints} />
            </div>
          )}
          {(row.lanes.length > 0 || base) && (
            <ExactRecord
              rows={[
                ['Intent', row.id],
                ['Base', base],
              ]}
            />
          )}
        </>
      )}
    </Panel>
  );
  return (
    <WorkDetailLayout
      className="fx-intent-page"
      crumbs={back}
      header={
        <div className="fx-lane-head">
          <div className="fx-lane-head-main">
            <h1>
              <Glyph name="intent" size={18} />
              {row.outcome}
              {statusControl ?? <StatusPill tone={row.tone}>{row.label}</StatusPill>}
            </h1>
            <div className="fx-lane-meta">
              {meta ?? (
                <>
                  {planning
                    .filter(item => item.kind === 'initiative')
                    .map(item => (
                      <span key={item.id}>
                        <Glyph name="initiative" size={12} /> {item.title}
                      </span>
                    ))}
                  <span>
                    {row.lanes.length} {row.lanes.length === 1 ? 'Lane' : 'Lanes'} ·{' '}
                    {row.lanes.filter(lane => lane.accepted).length} landed
                    {unsynced > 0 && <> · {unsynced} not yet synced</>}
                    {queued > 0 && <> · {queued} queued</>}
                    {waitingForYou > 0 && <> · {waitingForYou} waiting for you</>}
                  </span>
                  <span>
                    {views.length} {views.length === 1 ? 'Candidate' : 'Candidates'}
                    {(unsynced === 0 || views.some(view => view.accepted)) && (
                      <> · {views.filter(view => view.accepted).length} accepted</>
                    )}
                  </span>
                  {row.createdAt && (
                    <span>
                      started {age(row.createdAt, now, true)}
                      {row.createdBy && <> by {row.createdBy}</>}
                    </span>
                  )}
                </>
              )}
            </div>
          </div>
          <div className="fx-lane-head-actions">
            {addLane && <AddLane add={name => run(addLane(name))} />}
            {!canStart && (
              <>
                <Button variant="ghost" disabled title="This planning item has no linked Work Intent yet">
                  Add Lane
                </Button>
                <Button disabled title="This planning item has no linked Work Intent yet">
                  Hand to an agent
                </Button>
              </>
            )}
            {!addLane && canStart && <AddLaneHandoff intentId={startIntentId} />}
            {canStart && (
              <CopyPrompt
                variant="secondary"
                request={{ situation: 'start-intent', intentId: startIntentId }}
                label="Hand to an agent"
                initiallyOpen={delegateRequested()}
                onClose={clearDelegate}
              />
            )}
            {onEdit && (
              <Button variant="ghost" icon="pencil" onClick={onEdit}>
                Edit
              </Button>
            )}
            {editHref && (
              <ButtonLink variant="ghost" icon="pencil" href={editHref}>
                Edit
              </ButtonLink>
            )}
            <Menu label={<Glyph name="more" size={16} />} ariaLabel="More">
              <ObjectActions head={[...views].reverse().find(view => view.head)?.head ?? base} />
              {combine && <Combine lanes={row.lanes} run={combine} />}
              {setStatus && (
                <Button variant="ghost" onClick={() => void run(setStatus(open ? 'completed' : 'active'))}>
                  {open ? 'Mark done' : 'Reopen'}
                </Button>
              )}
              {more}
            </Menu>
          </div>
        </div>
      }
      next={
        <>
          {error && <ErrorToast>{error}</ErrorToast>}
          {open && failed?.queue && (
            <section className="fx-next fx-tone-failed" role="status">
              <span className="fx-next-icon">
                <Glyph name="failed" size={16} />
              </span>
              <div>
                <h2>Candidate from «{failed.name}» failed its check</h2>
                <p>{failed.queue.check}</p>
              </div>
              <div className="fx-next-actions">
                {failed.queue.link && (
                  <ButtonLink size="sm" href={queueHref(failed.queue.link)}>
                    Open run
                  </ButtonLink>
                )}
                {failed.queue.repairIntentId && (
                  <ButtonLink
                    size="sm"
                    variant="ghost"
                    href={queueHref({
                      kind: 'repair-intent',
                      id: failed.queue.repairIntentId,
                      label: 'Repair in Lane',
                    })}
                  >
                    Repair in Lane
                  </ButtonLink>
                )}
              </div>
            </section>
          )}
          {open && !failed && ready && reviewHref && dismissed !== ready.id && (
            <section className="fx-next fx-tone-passed" role="status">
              <span className="fx-next-icon">
                <Glyph name="check" size={16} />
              </span>
              <div>
                <h2>
                  Candidate from {ready.lanes || 'this Intent'} passed {ready.checkName ?? 'check'}
                </h2>
                <p>{age(checkedAt ?? ready.at, now, true)}</p>
              </div>
              <div className="fx-next-actions">
                <ButtonLink variant="secondary" size="sm" href={reviewHref(ready.id)}>
                  Review &amp; accept
                </ButtonLink>
                <Button size="sm" variant="ghost" onClick={() => setDismissed(ready.id)}>
                  Not now
                </Button>
              </div>
            </section>
          )}
        </>
      }
      timelineCount={timeline.length}
      messageCount={notes.length}
      side={
        <>
          <Panel
            title="Timeline"
            footer={activityMore}
            count={timeline.length}
            actions={<CollapseSideButton />}
          >
            {timeline.length ? (
              <ol className="fx-feed">
                {timeline.map(event => (
                  <li key={event.id}>
                    <time className="fx-feed-time" title={new Date(event.at).toISOString()}>
                      {age(event.at, now)}
                    </time>
                    <span className={`fx-feed-glyph fx-fact-${event.tone}`}>
                      <Glyph name={event.glyph} size={12} />
                    </span>
                    <div className="fx-feed-text">
                      {event.text}
                      {event.lane && (
                        <>
                          {' '}
                          <LaneTag
                            lane={event.lane}
                            href={`${laneHref(event.lane.id).split('#')[0]}#${eventAnchor(event.id)}`}
                          />
                        </>
                      )}
                      {event.detail && <span className="fx-feed-detail">{event.detail}</span>}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="fx-panel-note">No activity yet.</p>
            )}
          </Panel>
          {conversation ?? (
            <Conversation
              notes={notes}
              now={now}
              laneHref={laneHref}
              {...(addNote ? { add: addNote } : {})}
              {...(sendMessage ? { send: sendMessage } : {})}
            />
          )}
        </>
      }
    >
      {details}
      <OwnerDecisionsPanel intentId={row.id} />
      {row.lanes.length > 0 && (
        <WorkMap
          compact
          now={now}
          parentTitle={row.outcome}
          lanes={row.lanes}
          views={views}
          laneHref={laneHref}
          viewHref={viewHref ?? reviewHref}
        />
      )}
      <Panel
        title="Lanes"
        count={row.lanes.length}
        actions={
          canStart &&
          (addLane ? (
            <AddLane add={name => run(addLane(name))} />
          ) : (
            <AddLaneHandoff intentId={startIntentId} />
          ))
        }
      >
        {row.lanes.length ? (
          <ul className="fx-intent-lanes">
            {[...row.open, ...row.lanes.filter(lane => !lane.open)].map(lane => {
              const fact = facts.get(lane.id);
              return (
                <WorkRow
                  key={lane.id}
                  title={lane.name}
                  href={laneHref(lane.id)}
                  tone={fact?.tone ?? lane.tone}
                  label={fact?.label ?? lane.label}
                  done={!lane.open}
                  {...(fact?.pillGlyph ? { pillGlyph: fact.pillGlyph } : {})}
                  fact={fact ? <LaneFactLine fact={fact} showIntent={false} /> : lane.fact}
                  age={lane.lastAt ? age(lane.lastAt, now) : undefined}
                />
              );
            })}
          </ul>
        ) : (
          <div className="fx-intent-empty">
            <span>No Lane yet.</span>
            {canStart && (
              <>
                <CopyPrompt
                  variant="secondary"
                  request={{ situation: 'start-intent', intentId: startIntentId }}
                  label="Hand to an agent"
                />
                <CopyStartCommand intentId={startIntentId} />
              </>
            )}
            {!canStart && (
              <>
                <Button size="sm" disabled title="This planning item has no linked Work Intent yet">
                  Hand to an agent
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled
                  title="This planning item has no linked Work Intent yet"
                >
                  Copy start command
                </Button>
              </>
            )}
          </div>
        )}
      </Panel>
      {views.length > 0 && (
        <Candidates
          row={row}
          views={views}
          now={now}
          laneHref={laneHref}
          reviewHref={reviewHref}
          viewHref={viewHref}
          records={records}
          base={base}
        />
      )}
    </WorkDetailLayout>
  );
}
