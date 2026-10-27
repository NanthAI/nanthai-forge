// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import type { LaneFact } from '../ui/lane-facts';
import { ProgressHeader } from '../ui/Rail';
import { Panel } from '../ui/primitives';
import { attentionRank } from '../ui/status';
import { ScaleGroups, ScaleStatusCounts } from './ScaleList';
import { groupByInitiative, SCALE_AFTER, type InitiativeLinks } from './scale-model';
import { LaneRow } from './LaneRow';
import type { CockpitLane } from './model';

const SHOWN = 5;

/**
 * What's changing: every open Lane as an ordinary row, by attention then most recent. Five rows,
 * then one fold that says what the rest are doing.
 */
export function LaneList({
  lanes,
  facts,
  now,
  loading,
  href,
  viewHref,
  initiatives = new Map(),
}: {
  initiatives?: InitiativeLinks;
  lanes: readonly CockpitLane[];
  /** Fact lines from `laneFacts`; rows fall back to the cockpit's words without them. */
  facts?: ReadonlyMap<string, LaneFact>;
  now: number;
  loading?: boolean;
  href: (lane: CockpitLane) => string;
  viewHref?: (id: string) => string;
}) {
  const [showAll, setShowAll] = useState(false);
  const tone = (lane: CockpitLane) => facts?.get(lane.id)?.tone ?? lane.tone;
  const label = (lane: CockpitLane) => facts?.get(lane.id)?.label ?? lane.label;
  const words = (lane: CockpitLane) => ({ label: label(lane), tone: tone(lane) });
  const last = (lane: CockpitLane) =>
    Math.max(Date.parse(lane.lastAt ?? '') || 0, lane.session?.lastSeen ?? 0);
  const open = lanes
    .filter(lane => lane.open && !lane.accepted)
    .sort((a, b) => attentionRank[tone(a)] - attentionRank[tone(b)] || last(b) - last(a));
  // Not seen Lanes stay listed but are not counted as in motion.
  const moving = open.filter(lane => tone(lane) !== 'stale').length;
  const scale = open.length > SCALE_AFTER;
  const render = (lane: CockpitLane) => (
    <LaneRow
      key={lane.id}
      lane={lane}
      {...(facts?.get(lane.id) ? { fact: facts.get(lane.id)! } : {})}
      now={now}
      href={href(lane)}
      viewHref={viewHref}
    />
  );
  const rest = open.slice(SHOWN);
  const restWords = [...new Set(rest.map(label))]
    .map(word => `${rest.filter(lane => label(lane) === word).length} ${word.toLowerCase()}`)
    .join(', ');
  return (
    <Panel
      title="What's changing"
      count={moving ? `${moving} in motion` : undefined}
      labelId="fx-changing"
      {...(open.some(lane => lane.session || lane.startedBy || lane.owner) ? {} : { className: 'fx-nowho' })}
    >
      {loading && !open.length ? (
        <p className="fx-loading" role="status">
          Reading Lanes…
        </p>
      ) : open.length === 0 ? (
        <p className="fx-panel-note">No work in motion.</p>
      ) : scale ? (
        <>
          <div className="fx-scale-totals">
            <ScaleStatusCounts rows={open.map(words)} />
          </div>
          <ScaleGroups
            groups={groupByInitiative(open, initiatives, lane => lane.intentId)}
            render={render}
            className="fx-rows"
            noun="Lane"
            summary={rows => <ScaleStatusCounts rows={rows.map(words)} />}
          />
        </>
      ) : (
        <>
          <div className="fx-col-h">
            <span>Lane · by attention</span>
            <span>Who</span>
            <ProgressHeader />
            <span>Diff</span>
            <span>Age</span>
          </div>
          <ul className="fx-rows">{(showAll ? open : open.slice(0, SHOWN)).map(render)}</ul>
        </>
      )}
      {!scale && rest.length > 0 && (
        <button
          type="button"
          className="fx-fold"
          aria-expanded={showAll}
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? (
            'Show fewer Lanes'
          ) : (
            <>
              <b>
                {rest.length} more {rest.length === 1 ? 'Lane' : 'Lanes'}
              </b>
              <span className="fx-faint">· {restWords}</span>
            </>
          )}
        </button>
      )}
    </Panel>
  );
}
