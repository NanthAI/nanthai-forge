// SPDX-License-Identifier: Apache-2.0
// The owner's decision on the Lane page (Item 48049998): when this Lane is held for the reader's approval, the same
// Approve and land / Decline as Needs me, from the same read (projectNeedsMe:read, shared with the top bar's count
// and Needs me when open) and the same calls (decide.ts). Read only while the Lane is held (`useHeldView`, which the
// page's hold sentence shares); otherwise it costs nothing.
import { useMemo, useState } from 'react';
import { useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import type { Id } from '../../../../convex/_generated/dataModel';
import { State } from '../../ds';
import { decideTarget, useProjectDecide } from './decide';
import { DecisionKeys } from './DecisionKeys';
import { needsView, type NeedsRead } from './model';

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
  read,
}: {
  projectId: Id<'hostedProjects'>;
  laneId: string;
  held: boolean;
  read: ReturnType<typeof useHeldView>;
}) {
  const decide = useProjectDecide(projectId);
  // A plain status line, not the behaviour layer: it stays after the hold ends, saying what happened.
  const [message, announce] = useState('');
  const row = useMemo(() => read?.view.now.find(entry => entry.laneId === laneId), [read, laneId]);
  const target = row ? decideTarget(row) : null;
  const said = message ? (
    <p className="quietline" role="status">
      {message}
    </p>
  ) : null;
  if (!held || !read?.canDecide || !row || !target) return said;
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
}
