// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Change plan (Item 1fbf61b9): compare the plans in one table and preview what changes, when and the next invoice.
// The pay step hands off to a hosted payment page; P7 has none, so its outcomes are sample moments.
import { Fragment, useMemo, useState } from 'react';
import { Key, Region, State } from '../ds';
import { A } from '../app/frames';
import { navigate } from '../app/router';
import { createBillingActions, operationId, type Checkout, type CheckoutState } from './actions';
import { extraBlock, plans, type PlanId } from './contract';
import { money, number } from './figures';
import { BillingHead, type Moment, type ScreenProps } from './Head';
import {
  cheaperPlan,
  cheapestAt,
  costAt,
  dayMonth,
  paceAssumption,
  paceLandings,
  planChange,
  planOrder,
} from './preview';
import { billingHref } from './sections';

const moments: readonly Moment[] = [
  { value: 'start', label: 'Before paying' },
  { value: 'handoff', label: 'On the payment page' },
  { value: 'confirm', label: 'Bank confirms' },
  { value: 'declined', label: 'Card declined' },
  { value: 'unknown', label: 'Result unknown' },
  { value: 'paid', label: 'Paid' },
];
const isPlan = (v: string | null): v is PlanId => v === 'hobby' || v === 'pro' || v === 'team';
const lastDay = (resetAt: string) => dayMonth(new Date(Date.parse(resetAt) - 86_400_000).toISOString());

export default function ChangePlan({ snapshot, sample, view, search }: ScreenProps) {
  const step = moments.some(m => m.value === search.get('step')) ? (search.get('step') as string) : 'start';
  const actions = useMemo(
    () => createBillingActions({ checkout: step === 'start' ? undefined : (step as CheckoutState) }),
    [step],
  );
  const [op, setOp] = useState(operationId);
  const pool = snapshot?.pool;
  const fit = pool ? cheapestAt(paceLandings(pool)) : 'hobby';
  const raw = search.get('to');
  const to: PlanId = isPlan(raw) ? raw : pool ? (cheaperPlan(pool)?.plan ?? pool.plan) : 'hobby';
  const change = pool ? planChange(pool, to) : null;
  const [checkout, setCheckout] = useState<Checkout | null>(() =>
    step !== 'start' && change?.direction === 'up' ? actions.checkout({ operationId: op, to }) : null,
  );
  const [scheduled, setScheduled] = useState(false);
  const canChange = view !== 'member';
  if (!pool || !change || !snapshot)
    return (
      <BillingHead
        title="Change plan"
        sample={sample}
        view={view}
        screen="plan"
        sentence="Loading the billing sample…"
        command="nforge billing plan"
        reply={null}
      />
    );
  const from = plans[change.from],
    target = plans[to],
    resets = dayMonth(pool.period.resetAt);
  const cheaper = cheaperPlan(pool);
  const saves = cheaper?.plan === to && cheaper.savesUsd ? money(cheaper.savesUsd, 0) : null;
  const sentence =
    change.direction === 'same' ? (
      <>
        <b>You are on {from.name}.</b>{' '}
        {cheaper ? `${plans[cheaper.plan].name} fits your pace better.` : 'It fits your pace.'}
      </>
    ) : change.direction === 'up' ? (
      <>
        <b>
          {saves
            ? `${target.name} costs ${saves} less than ${from.name} this month at your pace.`
            : to === fit
              ? `${target.name} fits your pace: about ${number(paceLandings(pool))} landings a month.`
              : `${target.name} includes ${number(target.includedLandings)} landings a month.`}
        </b>{' '}
        It starts today, and {pool.period.label}’s {number(pool.acceptedLandings)} landings count against{' '}
        {target.name}’s {number(target.includedLandings)}.
        {change.droppedBlocks ? ` The ${change.droppedBlocks} extra blocks are dropped.` : ''}
      </>
    ) : (
      <>
        <b>
          {saves
            ? `${target.name} would cost about ${saves} less a month at your pace.`
            : `${target.name} starts on ${resets}.`}
        </b>{' '}
        You keep {from.name} until then, so nothing you paid for is lost. Nothing is deleted.
      </>
    );
  const pay = (state: CheckoutState) => setCheckout(actions.settle(op, state));
  const begin = () => setCheckout(actions.checkout({ operationId: op, to }));
  const again = () => {
    const next = operationId();
    setOp(next);
    setCheckout(actions.checkout({ operationId: next, to }));
  };
  const lines = (
    <dl className="lines">
      {change.direction === 'up' ? (
        <>
          <dt>
            {target.name}, {dayMonth(pool.period.asOf)} to {lastDay(pool.period.resetAt)}
            <small>
              {change.daysCharged} of {change.daysInPeriod} days. The full {number(target.includedLandings)}{' '}
              landings are included: {number(pool.acceptedLandings)} used, {number(change.remainingNow)} left
            </small>
          </dt>
          <dd>{money(change.newPlanUsd)}</dd>
          {change.creditUsd ? (
            <>
              <dt>{from.name}, already paid for those days</dt>
              <dd>−{money(change.creditUsd)}</dd>
            </>
          ) : null}
          {change.droppedBlocks ? (
            <>
              <dt>
                Extra landings in {pool.period.label}
                <small>
                  {change.droppedBlocks} blocks started on {from.name}, now inside {target.name}: not billed
                </small>
              </dt>
              <dd>{money(0)}</dd>
            </>
          ) : null}
          <dt>Tax, sample</dt>
          <dd>{money(0)}</dd>
          <dt className="sum">Charged today</dt>
          <dd className="sum">{money(change.chargedTodayUsd)}</dd>
        </>
      ) : (
        <>
          <dt>
            Until {lastDay(pool.period.resetAt)}
            <small>
              {from.name} stays: {number(from.includedLandings)} landings, {number(pool.acceptedLandings)}{' '}
              used
            </small>
          </dt>
          <dd>paid</dd>
          <dt>
            From {resets}
            <small>
              {target.name}: {number(target.includedLandings)} landings a month.
              {to === 'hobby'
                ? ` Past ${number(target.includedLandings)}, landings wait until the next month`
                : ''}
            </small>
          </dt>
          <dd>{target.monthlyUsd ? `${money(target.monthlyUsd, 0)} a month` : 'Free'}</dd>
          <dt className="sum">Charged today</dt>
          <dd className="sum">{money(0)}</dd>
        </>
      )}
    </dl>
  );
  const amount = money(change.chargedTodayUsd);
  const notice =
    checkout?.state === 'declined' ? (
      <div className="notice" data-st="failed" role="alert">
        <State word="Card declined" />
        <p>
          <b>The bank declined the card. Nothing was charged and you are still on {from.name}.</b> Try another
          card on the payment page, or ask your bank.
        </p>
      </div>
    ) : checkout?.state === 'unknown' ? (
      <div className="notice" data-st="waiting" role="status">
        <State word="Confirming" />
        <p>
          <b>The payment page has not answered, so Forge does not know if {amount} was taken.</b> You are
          still on {from.name}. Do not pay again: checking reads the same payment{' '}
          <span className="mono">{checkout.operationId.slice(0, 8)}</span>, and nothing is owed if it was not
          taken.
        </p>
        <Key size="sm" onClick={() => setCheckout(actions.reconcile(checkout.operationId))}>
          Check now
        </Key>
      </div>
    ) : checkout?.state === 'paid' ? (
      <div className="notice" data-st="passed" role="status">
        <State word="Paid" />
        <p>
          <b>
            {amount} paid. You are on {target.name}: {number(change.remainingNow)} landings left in{' '}
            {pool.period.label}.
          </b>{' '}
          Lanes waiting on the plan land by themselves, in queue order.
        </p>
        <A className="btn sm" href={billingHref('invoices', sample, view)}>
          Open invoices
        </A>
      </div>
    ) : null;
  const outcomes = (
    <p className="billing-note">
      Sample: the payment page would report{' '}
      {(['paid', 'declined', 'unknown'] as const).map((s, i) => (
        <Fragment key={s}>
          {i ? ' · ' : ''}
          <button type="button" className="lk" onClick={() => pay(s)}>
            {s === 'paid' ? 'paid' : s === 'declined' ? 'declined' : 'no answer'}
          </button>
        </Fragment>
      ))}
    </p>
  );
  const flow =
    change.direction !== 'up' ? null : !checkout || checkout.state === 'declined' ? (
      <>
        <div className="btns">
          <Key kind="primary" size="lg" onClick={checkout ? again : begin}>
            {checkout ? 'Try another card' : `Continue to the payment page to pay ${amount}`}
          </Key>
          <A className="btn ghost" href={billingHref('home', sample, view)}>
            Stay on {from.name}
          </A>
        </div>
        <p className="billing-note">
          The payment page takes the card and any tax ID, then brings you back here. Forge never sees the card
          number, and nothing changes until the page says it is paid.
        </p>
      </>
    ) : checkout.state === 'handoff' || checkout.state === 'confirm' ? (
      <>
        <div className="foreign billing-handoff">
          <b>
            {checkout.state === 'confirm'
              ? 'Your bank wants to confirm it is you.'
              : 'The payment page is open.'}
          </b>
          <span>
            {checkout.state === 'confirm'
              ? 'Nothing is charged until it does. You are still on ' + from.name + '.'
              : 'Sample: no payment page opens in this preview, and nothing is charged.'}
          </span>
        </div>
        <div className="btns">
          <Key kind="primary" size="lg" disabled>
            {checkout.state === 'confirm' ? 'Waiting for your bank…' : 'Waiting for the payment page…'}
          </Key>
        </div>
        {outcomes}
      </>
    ) : checkout.state === 'unknown' ? (
      <>
        <p>
          Paying twice is not possible from here: the pay button comes back only when the payment page says
          this attempt failed.
        </p>
        {outcomes}
      </>
    ) : null;
  return (
    <>
      <BillingHead
        title="Change plan"
        sample={sample}
        view={view}
        screen="plan"
        sentence={sentence}
        command={`nforge billing plan --to ${to}`}
        reply={`asked     ${pool.owner.handle}, who pays for this pool. The request is in their Needs you\nwhy       an agent can read the plan and ask for a change; only a person can agree to pay\nnow       ${from.name}, ${number(pool.acceptedLandings)} of ${number(from.includedLandings)} landings used\nif yes    ${target.name} ${change.direction === 'up' ? 'from today' : `from ${resets}`}, ${number(target.includedLandings)} landings a month`}
        moments={moments}
        moment={step}
      />
      {notice}
      <div className="panes billing-two">
        <Region title="Plans" hint="every plan has every feature; they differ by landings a month">
          <table className="t stack billing-plans">
            <caption className="sr">Plans compared, sample data</caption>
            <thead>
              <tr>
                <th scope="col">Plan</th>
                <th scope="col">A month</th>
                <th scope="col">Landings a month</th>
                <th scope="col" className="l">
                  {pool.period.label} at your pace
                </th>
                <th scope="col">
                  <span className="sr">Choose</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {planOrder.map(id => {
                const p = plans[id],
                  cost = costAt(id, paceLandings(pool));
                return (
                  <tr key={id} className={id === to && id !== pool.plan ? 'sel' : undefined}>
                    <td>
                      <span className="name">{p.name}</span>
                      {id === pool.plan ? <span className="sub">your plan</span> : null}
                    </td>
                    <td className="amt">{p.monthlyUsd ? money(p.monthlyUsd, 0) : 'Free'}</td>
                    <td data-k="Landings a month">{number(p.includedLandings)}</td>
                    <td className="l">
                      {!cost
                        ? `Landings wait once ${number(p.includedLandings)} are used`
                        : cost.blocks
                          ? `${money(cost.usd, 0)}: ${money(p.monthlyUsd, 0)} and ${cost.blocks} extra ${cost.blocks === 1 ? 'block' : 'blocks'}`
                          : `${cost.usd ? money(cost.usd, 0) : 'Free'}, inside the plan`}
                      {id === fit ? <span className="tag-rec">fits your pace</span> : null}
                    </td>
                    <td className="act">
                      {id === pool.plan || !canChange ? null : id === to ? (
                        <span className="t2">chosen</span>
                      ) : (
                        <Key
                          size="sm"
                          onClick={() =>
                            navigate(billingHref('plan', sample, view, { to: id }), { replace: true })
                          }
                        >
                          Choose {p.name}
                        </Key>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="pf">
            {paceAssumption(pool)} Extra landings on Pro and Team: {money(extraBlock.usd, 0)} per{' '}
            {number(extraBlock.landings)}, up to the limit you set. Monthly billing only.
          </div>
        </Region>
        <Region
          title="What changes"
          hint={
            change.direction === 'same'
              ? undefined
              : `${from.name} to ${target.name}, ${change.direction === 'up' ? 'today' : `on ${resets}`}`
          }
        >
          {change.direction === 'same' ? (
            <p className="quietline">Choose another plan to see what changes.</p>
          ) : !canChange ? (
            <p className="quietline">Only {pool.owner.handle} and billing managers change the plan.</p>
          ) : (
            <div className="billing-confirm">
              <h3>
                Move to {target.name} {change.direction === 'up' ? 'today' : `on ${resets}`}
              </h3>
              {lines}
              {change.direction === 'up' ? (
                <p>
                  From {resets}: {money(target.monthlyUsd, 0)} a month before tax, on the 1st. Moving back
                  applies when the paid month ends.
                </p>
              ) : (
                <p>
                  Projects, history, people, settings and past invoices stay. Change your mind before {resets}{' '}
                  and nothing happens.
                </p>
              )}
              {flow}
              {change.direction === 'down' ? (
                <div className="btns">
                  {scheduled ? (
                    <p role="status">
                      Sample: {target.name} would start on {resets}; nothing changed.{' '}
                      <Key size="sm" kind="ghost" onClick={() => setScheduled(false)}>
                        Undo
                      </Key>
                    </p>
                  ) : (
                    <>
                      <Key
                        kind="rec"
                        size="lg"
                        onClick={() => setScheduled(actions.schedulePlan({ operationId: op, to }).ok)}
                      >
                        Move to {target.name} on {resets}
                      </Key>
                      <A className="btn ghost" href={billingHref('home', sample, view)}>
                        Keep {from.name}
                      </A>
                    </>
                  )}
                </div>
              ) : null}
            </div>
          )}
        </Region>
      </div>
    </>
  );
}
