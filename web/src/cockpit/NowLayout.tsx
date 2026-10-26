// SPDX-License-Identifier: Apache-2.0
import { Fragment, type ReactNode } from 'react';
import { Situation } from '../ui/signals';

/** The facts the situation line summarises. Counts link to the panel that lists them. */
export type NowFacts = {
  decisions: number;
  open: number;
  /** Acceptances into main today; equals the Accepted section's Today band. */
  acceptedToday?: number;
  working?: {
    total: number;
    agents: number;
    subagents?: number;
    people: readonly string[];
    /** People working, when their names are not all known. */
    peopleCount?: number;
    /** Lanes with recent saves or checks but no announced session. */
    unannounced?: number;
  };
  overlaps: number;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One sentence: what needs the viewer first, then movement, people, overlaps and today's acceptances. */
export function NowSituation({ facts, firstRun = false }: { facts: NowFacts; firstRun?: boolean }) {
  const { decisions, open, acceptedToday = 0, working, overlaps } = facts;
  if (firstRun) return <Situation lead="Nothing is in progress yet.">Start with one Intent.</Situation>;
  if (open === 0 && decisions === 0 && !working?.total && !acceptedToday)
    return <Situation lead="Nothing needs you.">No work in motion.</Situation>;
  const parts: ReactNode[] = [];
  if (open)
    parts.push(
      <>
        <a href="#fx-changing">{plural(open, 'Lane')}</a> in motion
      </>,
    );
  if (working?.total) {
    const named = working.people.slice(0, 2);
    const unnamed = (working.peopleCount ?? working.people.length) - named.length;
    const who = [
      working.agents && plural(working.agents, 'agent'),
      working.subagents && plural(working.subagents, 'subagent'),
      ...named,
      unnamed > 0 &&
        plural(unnamed, named.length ? 'other person' : 'person', named.length ? 'other people' : 'people'),
    ].filter(Boolean);
    parts.push(
      <>
        <a href="#fx-who">{working.total} working</a>
        {who.length > 0 && (
          <>
            {' '}
            (<a href="#fx-who">{who.join(', ')}</a>)
          </>
        )}
      </>,
    );
  }
  if (overlaps)
    parts.push(
      <>
        <a href="#fx-overlaps">{plural(overlaps, 'overlapping file')}</a>
      </>,
    );
  if (acceptedToday) parts.push(<a href="#fx-accepted-title">{acceptedToday} accepted today</a>);
  return (
    <>
      <div className="fx-now-mobile-situation">
        <Situation lead={<a href="#fx-needs-title">{decisions} need you</a>}>
          {' · '}
          <a href="#fx-changing">{open} in motion</a>
        </Situation>
      </div>
      <div className="fx-now-desktop-situation">
        <Situation
          lead={
            decisions ? (
              <a href="#fx-needs-title">
                {plural(decisions, 'thing')} {decisions === 1 ? 'needs' : 'need'} you.
              </a>
            ) : (
              'Nothing needs you.'
            )
          }
        >
          {parts.map((part, index) => (
            <Fragment key={index}>
              {index > 0 && ' · '}
              {part}
            </Fragment>
          ))}
          {parts.length > 0 && '.'}
        </Situation>
      </div>
    </>
  );
}

/**
 * Now: title and situation, the away strip, three equal-height cards in reading order — decisions,
 * movement, people — then Accepted at full width. Below 1060px everything stacks in that order.
 */
export function NowLayout({
  title = 'Now',
  situation,
  actions,
  away,
  needs,
  changing,
  people,
  accepted,
  first,
}: {
  title?: ReactNode;
  situation: ReactNode;
  actions?: ReactNode;
  away?: ReactNode;
  needs: ReactNode;
  changing: ReactNode;
  people?: ReactNode;
  /** Accepted work, full width under the cards. */
  accepted?: ReactNode;
  /** First-run content replaces the decisions and movement columns. */
  first?: ReactNode;
}) {
  return (
    <div className="fx-now2">
      <header className="fx-now2-head">
        <div className="fx-now2-txt">
          <h1>{title}</h1>
          {situation}
        </div>
        {actions && <div className="fx-now2-acts">{actions}</div>}
      </header>
      {away}
      <div
        className={
          first ? (people ? 'fx-now2-grid fx-now2-first' : 'fx-now2-grid fx-now2-only') : 'fx-now2-grid'
        }
      >
        {first ? (
          <div className="fx-now2-col">{first}</div>
        ) : (
          <>
            <div className="fx-now2-col">{needs}</div>
            <div className="fx-now2-col">{changing}</div>
          </>
        )}
        {people && <div className="fx-now2-col fx-now2-right">{people}</div>}
      </div>
      {!first && accepted}
    </div>
  );
}
