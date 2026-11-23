// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Who waits on whom, drawn (Item 8f94e5c3): each Lane a short chip with its state dot, an arrow to the Lane, person or
// main it waits on, the wait's time on the arrow. Longest wait first; a loop is drawn as a loop and marked. A phone
// stacks each chain downwards. The reason a Lane waits, and for a Lane far back the front of the queue, sit in one
// line under its chain (the blocked path, Item 9e748e41).
import type { StateKind } from '../../ds';
import { A } from '../frames';
import type { Wait } from './model';
import { age, waitChains, type Chain, type Step } from './wait-chains';

export type ChainLane = { title: string; state: StateKind; word: string };

type Props = {
  waits: readonly Wait[];
  laneOf: (laneId: string) => ChainLane;
  laneHref: (laneId: string) => string;
  decideHref: string;
  now: number;
};

export function WaitChains({ waits, ...rest }: Props) {
  const { chains, more } = waitChains(waits);
  return (
    <>
      <ul className="wc-list">
        {chains.map(chain => (
          <li key={chain.tail.laneId} className="wc" data-loop={chain.loop ? '' : undefined}>
            <ChainRow chain={chain} {...rest} />
          </li>
        ))}
      </ul>
      {more ? (
        <div className="pf">
          {more.toLocaleString()} more {more === 1 ? 'chain' : 'chains'} wait less long than these, none of
          them a loop.
        </div>
      ) : null}
    </>
  );
}

function ChainRow({ chain, laneOf, laneHref, decideHref, now }: Omit<Props, 'waits'> & { chain: Chain }) {
  const { tail } = chain;
  const first = chain.steps[0];
  const names = chain.steps.flatMap(step =>
    step.kind === 'lane' ? [laneOf(step.laneId).title] : step.kind === 'end' ? [step.label] : [],
  );
  return (
    <>
      <div
        className="wc-path"
        role="group"
        aria-label={`Waits${chain.since ? `, the oldest ${age(chain.since, now)}` : ''}: ${names.join(', then ')}`}
      >
        {chain.steps.map((step, index) => (
          <Place
            key={index}
            step={step}
            first={first === step}
            laneOf={laneOf}
            laneHref={laneHref}
            now={now}
          />
        ))}
        {chain.loop ? (
          <span
            className="wc-loop"
            data-st="waiting"
            title="These Lanes wait on each other, so none can go first"
          >
            <i aria-hidden="true">↺</i> Loop: each waits on the next
          </span>
        ) : null}
        {chain.steps.some(step => step.kind === 'end' && step.person) ? (
          <A className="btn sm rec wc-decide" href={decideHref}>
            Decide
          </A>
        ) : null}
      </div>
      <div className="wc-why meta" dir="auto">
        {tail.why || 'no reason was recorded'}
        {tail.front ? (
          <>
            {' · '}
            {tail.front.ahead.toLocaleString()} Lanes ahead; the queue moves when{' '}
            <A className="lk lanes-inline" href={laneHref(tail.front.laneId)} dir="auto">
              {tail.front.title}
            </A>{' '}
            lands ({tail.front.why})
          </>
        ) : null}
      </div>
    </>
  );
}

function Place({
  step,
  first,
  laneOf,
  laneHref,
  now,
}: {
  step: Step;
  first: boolean;
  laneOf: Props['laneOf'];
  laneHref: Props['laneHref'];
  now: number;
}) {
  const via = step.kind === 'skip' || first ? null : step.via;
  return (
    <>
      {step.kind === 'skip' ? (
        <span className="wc-arrow" aria-hidden="true">
          <i />
        </span>
      ) : first ? null : (
        <span className="wc-arrow" title={via?.why}>
          <span className="wc-age num">{via?.since ? age(via.since, now) : ''}</span>
          <i aria-hidden="true" />
        </span>
      )}
      {step.kind === 'lane' ? (
        (() => {
          const lane = laneOf(step.laneId);
          return (
            <A
              className="wc-chip"
              href={laneHref(step.laneId)}
              data-st={lane.state}
              data-joined={step.joined ? '' : undefined}
              title={`${lane.title} (${lane.word})`}
              dir="auto"
            >
              <i className="wc-dot" aria-hidden="true" />
              <span className="wc-t">{lane.title}</span>
              <span className="sr"> ({lane.word})</span>
            </A>
          );
        })()
      ) : step.kind === 'end' ? (
        <span className="wc-end" data-person={step.person ? '' : undefined}>
          {step.label}
        </span>
      ) : (
        <span className="wc-skip">{step.lanes.toLocaleString()} more Lanes</span>
      )}
    </>
  );
}
