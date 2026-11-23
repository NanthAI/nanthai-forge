// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// At the limit and billing elsewhere (Item 176db9fb): the plan-held moments, drawn once from one source (heldStory),
// so the rail foot, Needs-you row and decision, held Lane and agent tell agree. P7 renders them; P8 holds work.
import { useState } from 'react';
import { Key, Region, Row, State } from '../ds';
import { A } from '../app/frames';
import {
  extraBlock,
  landingAllowance,
  plans,
  poolUsage,
  remainingBudgetLine,
  type BillingPool,
} from './contract';
import { money, number } from './figures';
import { BillingHead, type Moment, type ScreenProps } from './Head';
import { costAt, dayMonth, heldStory, limitPace, paymentRecovery, whenWords } from './preview';
import { billingHref } from './sections';

const moments: readonly Moment[] = [
  { value: 'pace', label: 'Hobby: before the limit' },
  { value: 'at', label: 'Hobby: all used' },
  { value: 'handoff', label: 'Hobby: as a writer' },
  { value: 'resumed', label: 'Allowance back' },
  { value: 'past', label: 'Pro: first extra block' },
  { value: 'cap', label: 'Pro: at its limit' },
  { value: 'failed', label: 'Payment failed' },
];
type Step = 'pace' | 'at' | 'handoff' | 'resumed' | 'past' | 'cap' | 'failed';
const lanes = [
  { lane: '@sample-owner/still-heron', title: 'Retry budget for the fetch adapter' },
  { lane: '@sample-writer/copper-moth', title: 'Docs: migration guide' },
];
const shape: Record<
  Step,
  Pick<BillingPool, 'plan' | 'acceptedLandings' | 'projectedLandings' | 'extraBlocksAllowed'>
> = {
  pace: { plan: 'hobby', acceptedLandings: 286, projectedLandings: 572, extraBlocksAllowed: 0 },
  at: { plan: 'hobby', acceptedLandings: 300, projectedLandings: 600, extraBlocksAllowed: 0 },
  handoff: { plan: 'hobby', acceptedLandings: 300, projectedLandings: 600, extraBlocksAllowed: 0 },
  resumed: { plan: 'pro', acceptedLandings: 300, projectedLandings: 600, extraBlocksAllowed: 2 },
  past: { plan: 'pro', acceptedLandings: 1001, projectedLandings: 2002, extraBlocksAllowed: 2 },
  cap: { plan: 'pro', acceptedLandings: 2000, projectedLandings: 4000, extraBlocksAllowed: 2 },
  failed: { plan: 'pro', acceptedLandings: 746, projectedLandings: 1492, extraBlocksAllowed: 2 },
};

export default function LimitStates({ snapshot, sample, view, search }: ScreenProps) {
  const raw = search.get('step');
  const step: Step = moments.some(m => m.value === raw) ? (raw as Step) : 'at';
  const [answer, setAnswer] = useState<string | null>(null);
  if (!snapshot)
    return (
      <BillingHead
        title="Landing limit"
        sample={sample}
        view={view}
        screen="limit"
        sentence="Loading the billing sample…"
        command="nforge agent . needs-you"
        reply={null}
      />
    );
  const pool: BillingPool = { ...snapshot.pool, ...shape[step] };
  const owner = pool.owner.handle;
  const plan = plans[pool.plan];
  const usage = poolUsage(pool);
  const held = step === 'at' || step === 'handoff' || step === 'cap';
  const story = heldStory(pool, lanes.length);
  const pace = limitPace(pool);
  const resets = dayMonth(pool.period.resetAt);
  const recovery = step === 'failed' ? paymentRecovery('2026-11-01T00:00:00Z', pool.period.asOf) : null;
  const budget = remainingBudgetLine(landingAllowance(pool));
  const atPace = costAt(pool.plan, pool.projectedLandings ?? 0);
  const team = costAt('team', pool.projectedLandings ?? 0);
  const sentence = held ? (
    <>
      <b>
        Landings are waiting:{' '}
        {step === 'cap'
          ? `the ${pool.extraBlocksAllowed} extra blocks ${owner} allowed are used`
          : `${step === 'handoff' ? `${owner}’s` : 'all'} ${number(usage.included)} for ${pool.period.label} are used`}
        .
      </b>{' '}
      {story.waiting}. Saves carry on and nothing is lost.
    </>
  ) : step === 'pace' && pace.kind === 'near' ? (
    <>
      <b>
        {number(pace.left)} landings left in {pool.period.label}.
      </b>{' '}
      At this pace they are used {whenWords(pace)}; landings then wait until {resets}.
    </>
  ) : step === 'resumed' ? (
    <>
      <b>Landings resumed.</b> The {lanes.length} Lanes that waited land by themselves, in queue order.
      Nothing to resubmit.
    </>
  ) : step === 'past' ? (
    <>
      <b>
        Landing {number(pool.acceptedLandings)}: the first extra block of {number(extraBlock.landings)}{' '}
        started.
      </b>{' '}
      {money(extraBlock.usd, 0)} on the {resets} invoice.
    </>
  ) : (
    <>
      <b>The {pool.period.label} card payment failed.</b> Landings carry on until{' '}
      {recovery ? dayMonth(recovery.landingsUntil) : ''}.
    </>
  );
  const agent = held
    ? `$ nforge agent . land --save\n${story.agent(2)}\ntell     ${story.tell}`
    : step === 'resumed'
      ? `$ nforge agent . land --save\nlanded   Retry budget for the fetch adapter, on main\ncontinued  the original landing operation; no new land was needed`
      : `$ nforge agent . land --save\nlanded   Stream parser: handle split UTF-8, on main\n${budget ?? (step === 'past' ? `budget   landing ${number(pool.acceptedLandings)} of ${number(usage.included)} included; extra block 1 of ${pool.extraBlocksAllowed} started` : 'budget   no low-budget line applies')}`;
  const decide = (text: string) => setAnswer(`Sample: ${text} Nothing changed.`);
  const decision =
    step === 'at' ? (
      <div className="dec">
        <div className="dtop">
          <State word="Needs you" />
          <span>In queue</span>
          <span>{lanes.length} Lanes behind it</span>
        </div>
        <h3>
          Land the {lanes.length} waiting Lanes now, or wait until {resets}?
        </h3>
        <p className="why">
          Hobby includes {number(usage.included)} landings a month and has no grace landing. At this pace the
          month ends near {number(pool.projectedLandings ?? 0)}, so Pro’s {number(plans.pro.includedLandings)}{' '}
          covers it. Every plan has every feature.
        </p>
        <div className="btns">
          <A className="btn rec" href={billingHref('plan', sample, view, { to: 'pro' })}>
            Move to Pro, {money(plans.pro.monthlyUsd, 0)} a month
          </A>
          <Key
            onClick={() =>
              decide(`the ${lanes.length} Lanes would land by themselves on ${resets}, in order.`)
            }
          >
            Wait until {resets}
          </Key>
          <Key kind="ghost" onClick={() => decide('asked again tomorrow.')}>
            Later
          </Key>
        </div>
      </div>
    ) : step === 'handoff' ? (
      <div className="dec">
        <div className="dtop">
          <State word="Handoff" />
          <span>In queue</span>
        </div>
        <h3>
          Only {owner} can let landings resume before {resets}.
        </h3>
        <p className="why">
          {owner} pays for the pool this project draws from. Your Lane “{lanes[1]?.title}” is saved and lands
          by itself when landings resume.
        </p>
        <div className="btns">
          <Key kind="rec" onClick={() => decide(`${owner} would be told your Lane is waiting.`)}>
            Tell {owner} it is holding you up
          </Key>
          <Key kind="ghost" onClick={() => decide('asked again tomorrow.')}>
            Later
          </Key>
        </div>
      </div>
    ) : step === 'cap' ? (
      <div className="dec">
        <div className="dtop">
          <State word="Needs you" />
          <span>In queue</span>
          <span>{lanes.length} Lanes behind it</span>
        </div>
        <h3>Move to Team, allow more blocks, or wait until {resets}?</h3>
        <p className="why">
          {pool.period.label} is at {number(pool.acceptedLandings)} landings: Pro’s {number(usage.included)}{' '}
          and {usage.blocks} extra blocks, {money(plans.pro.monthlyUsd + usage.extraUsd, 0)} so far. At this
          pace the month ends near {number(pool.projectedLandings ?? 0)}: on Pro that is {atPace?.blocks}{' '}
          blocks, {money(atPace?.usd ?? 0, 0)}. Team includes {number(plans.team.includedLandings)} for{' '}
          {money(team?.usd ?? 0, 0)}.
        </p>
        <div className="btns">
          <A className="btn rec" href={billingHref('plan', sample, view, { to: 'team' })}>
            Move to Team, {money(plans.team.monthlyUsd, 0)} a month
          </A>
          <A className="btn" href={`${billingHref('payment', sample, view)}#limit`}>
            Allow more blocks
          </A>
          <Key onClick={() => decide(`the ${lanes.length} Lanes would land by themselves on ${resets}.`)}>
            Wait until {resets}
          </Key>
        </div>
      </div>
    ) : step === 'pace' ? (
      <div className="notice" data-st="waiting">
        <State word="Limit near" />
        <p>Saves and checks carry on. The plan holds nothing yet.</p>
        <A className="btn sm rec" href={billingHref('plan', sample, view, { to: 'pro' })}>
          See plans
        </A>
      </div>
    ) : step === 'past' ? (
      <div className="notice" data-st="stale">
        <State word="Extra block" />
        <p>
          You allowed up to {pool.extraBlocksAllowed} blocks; landings wait at {number(usage.ceiling ?? 0)}.
        </p>
        <A className="btn sm" href={`${billingHref('payment', sample, view)}#limit`}>
          Change the limit
        </A>
      </div>
    ) : step === 'failed' && recovery ? (
      <ol className="billing-timeline" aria-label="Payment recovery, newest first">
        <li>
          <span className="mono">{dayMonth(recovery.landingsUntil)}</span>
          <span>
            If still unpaid: back to Hobby’s {recovery.then.included} landings a month. Work past that waits
            in the queue, keeping its place. Nothing is deleted.
          </span>
        </li>
        {[...recovery.attempts].reverse().map(a => (
          <li key={a.day}>
            <span className="mono">{dayMonth(a.at)}</span>
            <span>
              Try {recovery.attempts.indexOf(a) + 1} of {recovery.attempts.length}, day {a.day}:{' '}
              {a.done ? <State word="Card declined" /> : 'planned'}
            </span>
          </li>
        ))}
        <li>
          <span className="mono">{dayMonth(pool.period.asOf)}</span>
          <span>
            Landings carry on meanwhile.{' '}
            <A className="lk" href={billingHref('payment', 'late', view)}>
              Replace the card
            </A>
          </span>
        </li>
      </ol>
    ) : (
      <p className="quietline">Nothing is waiting on the plan.</p>
    );
  return (
    <>
      <BillingHead
        title="Landing limit"
        sample={sample}
        view={view}
        screen="limit"
        sentence={sentence}
        command="nforge agent . needs-you"
        reply={held ? `1  ${story.row}` : 'nothing is waiting on the plan'}
        moments={moments}
        moment={step}
      />
      <div className="panes billing-two">
        <Region
          title={held ? 'Needs you' : step === 'failed' ? 'Payment recovery' : 'This month'}
          weight={held ? 'act' : 'watch'}
          hint="sample moment"
        >
          {decision}
          {answer ? (
            <p className="quietline" role="status">
              {answer}
            </p>
          ) : null}
        </Region>
        <div className="billing-stack">
          <Region
            title="Waiting to land"
            count={held ? lanes.length : 0}
            hint={held ? 'in queue order' : undefined}
          >
            {held || step === 'resumed' ? (
              lanes.map((l, i) => (
                <Row key={l.lane} cols="minmax(0, 1fr) auto">
                  <div>
                    <div className="ttl">{l.title}</div>
                    <div className="meta mono">
                      {l.lane} · position {i + 1}, place kept
                    </div>
                  </div>
                  {step === 'resumed' ? (
                    <State word={i ? 'Waiting its turn' : 'Checking'} />
                  ) : (
                    <State word="Landings wait" />
                  )}
                </Row>
              ))
            ) : (
              <p className="quietline">Nothing is waiting on the plan.</p>
            )}
          </Region>
          <Region title="What the agent was told" hint="in its own terminal">
            <pre className="cli-out mono billing-tell">{agent}</pre>
            <div className="pf">Taking a landing out of main is never held and never counts.</div>
          </Region>
          <Region title="Elsewhere" hint="one line each, pointing here">
            <dl className="kv">
              <dt>Rail</dt>
              <dd>
                {plan.name} plan ·{' '}
                {held
                  ? story.foot.words
                  : `${number(pool.acceptedLandings)} of ${number(usage.ceiling ?? usage.included)} landings`}
              </dd>
              <dt>Lanes</dt>
              <dd>{held ? `${story.waiting}; saves carry on. Decide in Needs you.` : 'No notice.'}</dd>
              <dt>A held Lane</dt>
              <dd>{held ? story.lane : 'Not held.'}</dd>
              <dt>Needs you</dt>
              <dd className="mono">{held ? story.row : 'No billing row.'}</dd>
            </dl>
          </Region>
        </div>
      </div>
    </>
  );
}
