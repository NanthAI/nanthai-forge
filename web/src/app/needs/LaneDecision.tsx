// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The owner's decision on the Lane page (Item 48049998): when this Lane is held for the reader's approval, the same
// Approve and land / Decline as Needs me, from the same read (projectNeedsMe:read, shared with the top bar's count
// and Needs me when open) and the same calls (decide.ts). An approval link names its landing (`?submission=`), so the
// page decides that exact attempt, even after a newer save moved the Lane's mark (Item 0a99ab23). A request asked
// before the Lane holds a landing, or declined while it still holds it, is decided from the Lane read's own row on
// the Lane's current save. Needs me is read only while the Lane is held or a landing is named; otherwise nothing.
import { useMemo, useState } from 'react';
import { useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import type { Id } from '../../../../convex/_generated/dataModel';
import { State } from '../../ds';
import { decideTarget, useProjectDecide } from './decide';
import { AheadKeys, DecisionKeys } from './DecisionKeys';
import { aheadRow, needsView, type Approval, type NeedsRead } from './model';

const needsRead = makeFunctionReference<'query', { projectId: Id<'hostedProjects'> }, NeedsRead>(
  'projectNeedsMe:read',
);

/** Needs me's read and view, only while the Lane is held; the Lane page's hold sentence and its decision share it. */
export function useHeldView(projectId: Id<'hostedProjects'>, held: boolean) {
  const read = useQuery(needsRead, held ? { projectId } : 'skip');
  return useMemo(() => (read ? { canDecide: read.canDecide, view: needsView(read) } : undefined), [read]);
}

export function LaneDecision({
  projectId,
  laneId,
  held,
  submission = null,
  request,
  head,
  read,
}: {
  projectId: Id<'hostedProjects'>;
  laneId: string;
  held: boolean;
  /** The landing an approval link named, when it did. */
  submission?: string | null;
  /** This Lane's open request, for its owner (the Lane read's `request`). */
  request?: Approval & { state: string; decision?: { reason?: string } };
  /** The Lane's current save: a Lane request's decision names it. */
  head: string;
  read: ReturnType<typeof useHeldView>;
}) {
  const decide = useProjectDecide(projectId);
  // A plain status line, not the behaviour layer: it stays after the hold ends, saying what happened.
  const [message, announce] = useState('');
  const row = useMemo(() => {
    const now = read?.view.now ?? [];
    const named = submission ? now.find(entry => entry.landing?.submissionId === submission) : undefined;
    return named ?? (held ? now.find(entry => entry.laneId === laneId) : undefined);
  }, [read, laneId, submission, held]);
  const target = row ? decideTarget(row) : null;
  const said = message ? (
    <p className="quietline" role="status">
      {message}
    </p>
  ) : null;
  if (row && target && read?.canDecide)
    return (
      <section className="dec lane-decision" aria-label="Your decision">
        <div className="dtop">
          <State word={row.word}>{row.tag}</State>
          <span>waits for you to land</span>
        </div>
        {row.note ? (
          <p className="why" dir="auto">
            {row.note}
          </p>
        ) : null}
        <div className="btns">
          <DecisionKeys laneId={laneId} target={target} decide={decide} announce={announce} />
        </div>
        {said}
      </section>
    );
  if (!request) return said;
  const ahead = aheadRow(request);
  const declined = request.state === 'declined';
  // Item 4f1f7984: a granted request is not listed in Needs me; this page says so, with nothing to decide.
  if (request.state === 'granted')
    return (
      <section className="dec lane-decision" aria-label="Your decision">
        <div className="dtop">
          <State word="Done">Approved</State>
          <span>you granted it</span>
        </div>
        <p className="why" dir="auto">
          {ahead.question}
        </p>
        <p className="why" dir="auto">
          {ahead.label}. {ahead.nextStep}
        </p>
        {said}
      </section>
    );
  return (
    <section className="dec lane-decision" aria-label="Your decision">
      <div className="dtop">
        <State word={ahead.word}>{ahead.tag}</State>
        <span>{declined ? 'you declined it' : 'holds nothing yet'}</span>
      </div>
      <p className="why" dir="auto">
        {ahead.question}
      </p>
      {declined && request.decision?.reason ? (
        <p className="why" dir="auto">
          You said: {request.decision.reason}
        </p>
      ) : null}
      <p className="why" dir="auto">
        {ahead.label}. {ahead.nextStep}
      </p>
      <div className="btns">
        <AheadKeys row={{ laneId, head }} declined={declined} decide={decide} announce={announce} />
      </div>
      {said}
    </section>
  );
}
