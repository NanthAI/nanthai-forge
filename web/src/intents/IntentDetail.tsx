import { Menu } from '../ui/Menu';
import { ErrorToast } from '../ui/Toast';
import { ObjectActions } from '../shell/ObjectActions';
// SPDX-License-Identifier: Apache-2.0
import { useState, type ReactNode } from 'react';
import { CopyPrompt } from '../cockpit/CopyPrompt';
import { clearDelegate, delegateRequested } from './useCreatedIntent';
import { canReviewView } from '../views/intent-views';
import { Combine } from '../views/Combine';
import { WorkMap } from '../views/WorkMap';
import '../views/views.css';
import { AddLane, Notes } from './IntentParts';

import { LaneRow } from '../cockpit/LaneRow';
import { Glyph } from '../ui/Glyph';
import { Button, ButtonLink, DiffStat, ExactRecord, Panel, StatusPill } from '../ui/primitives';
import { age, type Tone } from '../ui/status';
import type { IntentRow, IntentStatus } from './model';

export type ViewRow = {
  id: string;
  number?: number;
  changes?: { add: number; del: number };
  status: 'clean' | 'conflict';
  at: string;
  lanes: string;
  check?: string;
  checkName?: string;
  checkHead?: string;
  accepted: boolean;
  acceptedAt?: string;
  head?: string;
  supersededBy?: string | null;
  inputs?: { laneId: string; head: string; saveIndex?: number }[];
};
export type NoteRow = { text: string; kind: 'comment' | 'decision'; at: string };
export type PlanRow = { id: string; kind: 'issue' | 'initiative'; title: string; status: string };

const viewTone = (view: ViewRow): [Tone, string] =>
  view.supersededBy && !view.accepted
    ? ['stale', 'Superseded']
    : view.accepted
      ? ['passed', 'Accepted']
      : view.status === 'conflict'
        ? ['conflict', 'Conflict']
        : view.check === 'passed'
          ? ['passed', 'Check passed']
          : view.check === 'failed'
            ? ['failed', 'Check failed']
            : view.check === 'cancelled' || view.check === 'interrupted'
              ? ['stale', view.check === 'cancelled' ? 'Cancelled' : 'Interrupted']
              : view.check
                ? ['running', `Check ${view.check}`]
                : ['plain', 'Not checked'];

/** One Intent: its Lanes, its Candidates and their checks, decisions and linked planning. */
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
}: {
  row: IntentRow;
  views: readonly ViewRow[];
  notes: readonly NoteRow[];
  planning: readonly PlanRow[];
  now: number;
  laneHref: (id: string) => string;
  reviewHref?: (viewId: string) => string;
  viewHref?: (viewId: string) => string;
  combine?: (inputs: { laneId: string; head: string }[]) => Promise<string | null>;
  base?: string;
  back?: ReactNode;
  addLane?: (name: string) => Promise<string | null>;
  addNote?: (text: string, kind: NoteRow['kind']) => Promise<string | null>;
  setStatus?: (status: IntentStatus) => Promise<string | null>;
  more?: ReactNode;
}) {
  const [error, setError] = useState('');
  const [allViews, setAllViews] = useState(false);
  const run = async (action: Promise<string | null>) => {
    try {
      const error = await action;
      setError(error ?? '');
      return error;
    } catch (error) {
      const message = (error as Error).message;
      setError(message);
      return message;
    }
  };
  const ready = [...views].reverse().find(canReviewView);
  const open = row.status === 'active' || row.status === 'ready';
  return (
    <div className="fx-page fx-intent-page">
      {back}
      <div className="fx-lane-head">
        <div className="fx-lane-head-main">
          <h1>
            <span title="Intent">
              <Glyph name="intent" size={14} />
            </span>{' '}
            {row.outcome}
            <StatusPill tone={row.tone}>{row.label}</StatusPill>
          </h1>

          <div className="fx-lane-meta">
            <span>
              {row.lanes.length} {row.lanes.length === 1 ? 'Lane' : 'Lanes'}
              {row.lanes.length > 0 && `, ${row.lanes.filter(l => l.accepted).length} accepted`}
            </span>
            <span>
              {views.length} {views.length === 1 ? 'Candidate' : 'Candidates'},{' '}
              {views.filter(v => v.accepted).length} accepted
            </span>
            {row.createdAt && <span>started {age(row.createdAt, now, true)}</span>}
          </div>
        </div>
        <div className="fx-lane-head-actions">
          <ObjectActions head={[...views].reverse().find(v => v.head)?.head ?? base} />
          {ready && reviewHref && (
            <ButtonLink variant="primary" href={reviewHref(ready.id)}>
              Review and accept
            </ButtonLink>
          )}
          {addLane && <AddLane add={name => run(addLane(name))} />}
          {combine && <Combine lanes={row.lanes} run={combine} />}
          <Menu label="More">
            <CopyPrompt
              request={{ situation: 'start-intent', intentId: row.id }}
              label="Hand to an agent"
              initiallyOpen={delegateRequested()}
              onClose={clearDelegate}
            />
            {setStatus &&
              (open ? (
                <Button variant="ghost" onClick={() => void run(setStatus('completed'))}>
                  Mark complete
                </Button>
              ) : (
                <Button variant="ghost" onClick={() => void run(setStatus('active'))}>
                  Reopen
                </Button>
              ))}
            {more}
          </Menu>
        </div>
      </div>
      {error && <ErrorToast>{error}</ErrorToast>}
      {open && ready && (
        <p className="fx-situation">
          <b>Candidate {views.indexOf(ready) + 1} is ready for your review.</b>
        </p>
      )}
      {row.lanes.length > 0 && (
        <WorkMap
          now={now}
          parentTitle={row.outcome}
          lanes={row.lanes}
          views={views}
          laneHref={laneHref}
          viewHref={viewHref ?? reviewHref}
        />
      )}
      <div className="fx-lane-grid">
        <div className="fx-lane-col">
          <Panel title="Lanes" count={row.lanes.length}>
            {row.lanes.length === 0 ? (
              <p className="fx-panel-note">No Lanes yet.</p>
            ) : (
              <ul className="fx-lanes">
                {[...row.open, ...row.lanes.filter(lane => !lane.open)].map(lane => (
                  <LaneRow
                    key={lane.id}
                    lane={{
                      ...lane,
                      name: row.outcome.startsWith(lane.name)
                        ? `Lane · ${lane.checkpoints} ${lane.checkpoints === 1 ? 'save' : 'saves'}`
                        : lane.name,
                      intent: row.outcome.startsWith(lane.name)
                        ? `Lane · ${lane.checkpoints} ${lane.checkpoints === 1 ? 'save' : 'saves'}`
                        : lane.name,
                      ...(lane.accepted ? { tone: 'passed', label: 'Accepted', fact: 'Landed on main' } : {}),
                    }}
                    now={now}
                    href={laneHref(lane.id)}
                  />
                ))}
              </ul>
            )}
          </Panel>

          {row.constraints && row.constraints !== row.outcome && (
            <Panel title="What and why">
              <div className="fx-intent-why">{row.constraints}</div>
            </Panel>
          )}
          <Notes notes={notes} now={now} {...(addNote ? { add: addNote } : {})} />
        </div>
        <aside className="fx-lane-col">
          <section id="intent-views">
            <Panel title="Candidates" count={views.length}>
              {views.length === 0 ? (
                <p className="fx-panel-note">No Candidates yet.</p>
              ) : (
                <ul className="fx-views">
                  {[...views]
                    .reverse()
                    .slice(0, allViews ? undefined : 5)
                    .map(view => {
                      const [tone, label] = viewTone(view);
                      return (
                        <li key={view.id} title={view.head}>
                          <StatusPill tone={tone}>{label}</StatusPill>
                          {viewHref || reviewHref ? (
                            <a href={(viewHref ?? reviewHref)!(view.id)}>
                              <b>Candidate {views.indexOf(view) + 1}</b>
                              <span className="fx-view-row-lanes">
                                {view.inputs
                                  ?.map(input => {
                                    const lane = row.lanes.find(l => l.id === input.laneId);
                                    return `${lane?.name && !row.outcome.startsWith(lane.name) ? lane.name : `${view.inputs?.length ?? 1} ${(view.inputs?.length ?? 1) === 1 ? 'Lane' : 'Lanes'}`}${input.saveIndex != null && input.saveIndex >= 0 ? ` @ save ${input.saveIndex + 1}` : ''}`;
                                  })
                                  .join(' + ') || (view.lanes !== row.outcome ? view.lanes : '')}
                                {view.inputs?.every(
                                  input => input.saveIndex == null || input.saveIndex < 0,
                                ) &&
                                  view.check &&
                                  ` · Check ${view.check}`}
                              </span>
                            </a>
                          ) : (
                            <span>{view.lanes || 'Candidate'}</span>
                          )}
                          <span>
                            {view.changes && <DiffStat add={view.changes.add} del={view.changes.del} />}
                          </span>
                          <span className="fx-view-row-end">
                            <time className="fx-faint" title={view.at}>
                              {age(view.at, now)}
                            </time>
                            {canReviewView(view) && reviewHref && (
                              <a className="fx-view-review" href={reviewHref(view.id)}>
                                Review and accept
                              </a>
                            )}
                          </span>
                        </li>
                      );
                    })}
                </ul>
              )}
              {views.length > 5 && (
                <Button variant="ghost" onClick={() => setAllViews(!allViews)}>
                  {allViews ? 'Show fewer Candidates' : `${views.length - 5} more Candidates`}
                </Button>
              )}
            </Panel>
          </section>
          {planning.length > 0 && (
            <Panel title="Planning" count={planning.length || undefined}>
              {planning.length === 0 ? (
                <p className="fx-panel-note fx-flush">No Issues or Initiatives linked to this Intent.</p>
              ) : (
                <ul className="fx-plans">
                  {planning.map(item => (
                    <li key={item.id}>
                      <span className="fx-plan-kind">{item.kind === 'issue' ? 'Issue' : 'Initiative'}</span>
                      <span>{item.title}</span>
                      <span className="fx-faint">{item.status}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}
          <Panel>
            <ExactRecord
              rows={[
                ['Intent', row.id],
                ['Base', base],
              ]}
            />
          </Panel>
        </aside>
      </div>
    </div>
  );
}
