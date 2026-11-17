// SPDX-License-Identifier: Apache-2.0
// The account-wide P7 billing home. Every value is explicitly a stub; the adapter performs no IO.
import { useState, type ReactNode } from 'react';
import { Dock, Key, Region, State, useDockLayout, type DockLayout, type DockRegion } from '../ds';
import { A } from '../app/frames';
import { navigate, useSearch } from '../app/router';
import { extraBlock, landingAllowance, plans, poolUsage, remainingBudgetLine } from './contract';
import { billingSample, createBillingStub, type BillingView } from './stub';
import { Month, Months, money, number, resetDay } from './figures';
import { InvoiceFoot, Invoices, Payment, Plan, Projects, Statement, billingHref } from './sections';
import './billing.css';

const layout: DockLayout = {
  top: ['month'],
  a: ['projects', 'months'],
  b: ['plan', 'next', 'pay', 'invoices'],
};
const title: Record<string, string> = {
  plan: 'Change plan',
  invoices: 'Invoices',
  payment: 'Payment and details',
};
const skeleton = (
  <div className="billing-loading" aria-hidden="true">
    {[0, 1, 2, 3].map(n => (
      <div className="sk" key={n} />
    ))}
  </div>
);

export default function Billing() {
  const search = useSearch();
  const sample = billingSample(search.get('sample'));
  const rawView = search.get('view');
  const view: BillingView =
    rawView === 'member' || rawView === 'loading' || rawView === 'error' ? rawView : 'owner';
  const screen = search.get('screen') ?? 'home';
  const adapter = createBillingStub(sample, view);
  const state = adapter.read();
  const snapshot =
    state.status === 'ready' ? state.snapshot : state.status === 'error' ? state.previous : null;
  const [cli, setCli] = useState(false);
  const [asTable, setAsTable] = useState(false);
  const [arrangement, setArrangement, reset] = useDockLayout(
    `billing.${snapshot?.pool.owner.handle ?? 'sample'}.${view}`,
    layout,
  );
  const owner = snapshot?.pool.owner.handle ?? '@sample-owner';
  const usage = snapshot ? poolUsage(snapshot.pool) : null;
  const plan = snapshot ? plans[snapshot.pool.plan] : plans.hobby;
  const head = snapshot ? (
    snapshot.pool.acceptedLandings === 0 ? (
      <>
        {' '}
        <b>No landings yet this month.</b> {plan.name} includes {number(plan.includedLandings)} a month and
        costs {plan.monthlyUsd ? money(plan.monthlyUsd, 0) : 'nothing'}.
      </>
    ) : (
      <>
        {' '}
        <b>
          {number(snapshot.pool.acceptedLandings)} of {number(plan.includedLandings)} included landings used.
        </b>{' '}
        {usage?.extra
          ? `${number(usage.extra)} extra: ${usage.blocks} blocks, ${money(usage.extraUsd, 0)}.`
          : 'Nothing extra so far.'}
      </>
    )
  ) : (
    'Loading the billing sample…'
  );
  const change = (nextSample: string, nextView: string) =>
    navigate(billingHref('home', nextSample, nextView));
  const region = (
    id: string,
    name: string,
    children: ReactNode,
    hint?: ReactNode,
    count?: number,
    tools?: ReactNode,
  ): DockRegion => ({
    id,
    title: name,
    render: handle => (
      <Region
        title={name}
        handle={handle}
        hint={hint}
        count={count}
        tools={tools}
        weight={id === 'month' ? 'watch' : 'ref'}
      >
        {state.status === 'loading' ? skeleton : children}
      </Region>
    ),
  });
  const props = snapshot ? { snapshot, sample } : null;
  const regions = [
    region(
      'month',
      'This month',
      snapshot ? <Month snapshot={snapshot} /> : null,
      `1 to 30 November · one pool for every project ${owner} owns`,
    ),
    region(
      'projects',
      'By project',
      props ? <Projects key={`${sample}.${view}`} {...props} /> : null,
      'most landings first',
      snapshot?.projects.total,
    ),
    region(
      'months',
      'Month by month',
      snapshot ? <Months key={sample} snapshot={snapshot} table={asTable} /> : null,
      `${plan.name} includes ${number(plan.includedLandings)} a month`,
      undefined,
      <Key
        size="sm"
        kind="ghost"
        aria-expanded={asTable}
        aria-controls="billing-month-values"
        onClick={() => setAsTable(value => !value)}
      >
        {asTable ? 'Chart' : 'Table'}
      </Key>,
    ),
    region('plan', 'Plan', props ? <Plan {...props} /> : null),
    region(
      'next',
      'Next invoice',
      snapshot ? (
        <>
          <Statement invoice={snapshot.nextInvoice} />
          <InvoiceFoot snapshot={snapshot} />
        </>
      ) : null,
      snapshot?.nextInvoice ? resetDay(snapshot) : undefined,
    ),
    region('pay', 'Payment', props ? <Payment {...props} /> : null),
    region(
      'invoices',
      'Invoices',
      props ? <Invoices {...props} /> : null,
      'newest first',
      snapshot?.invoices?.total,
    ),
  ].filter(r => view !== 'member' || !['next', 'pay', 'invoices'].includes(r.id));
  const currentLayout =
    view === 'member'
      ? { ...arrangement, b: arrangement.b.filter(id => !['next', 'pay', 'invoices'].includes(id)) }
      : arrangement;
  const isSummary = Object.hasOwn(title, screen);
  return (
    <div className="billing">
      <div className="head">
        <h1>
          {isSummary ? (
            <>
              <A href={billingHref('home', sample, view)}>Billing</A> <span className="t3">›</span>{' '}
              {title[screen]}
            </>
          ) : (
            <>
              Billing{' '}
              <span className="t3 cut" title={owner} dir="auto" translate="no">
                · {owner}
              </span>
            </>
          )}
        </h1>
        <p className="sit">{head}</p>
        <div className="tools">
          {view === 'owner' && !isSummary ? (
            <A className="btn" href={billingHref('plan', sample)}>
              Change plan
            </A>
          ) : null}
          <Key
            className="cli mono"
            aria-controls="billing-cli"
            aria-expanded={cli}
            onClick={() => setCli(v => !v)}
          >
            nforge billing
          </Key>
          <span className="prop">Sample data · no charges</span>
        </div>
        <details className="billing-samples">
          <summary>Sample states</summary>
          <div className="btns">
            <label>
              Sample
              <select className="inp" value={sample} onChange={e => change(e.target.value, view)}>
                {['first', 'hobby', 'pro', 'team', 'over', 'late', 'worst'].map(value => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label>
              View
              <select className="inp" value={view} onChange={e => change(sample, e.target.value)}>
                {['owner', 'member', 'loading', 'error'].map(value => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </details>
      </div>
      {state.status === 'error' ? (
        <div className="notice" data-st="failed" role="alert">
          <State word="Not seen" />
          <p>{state.message}</p>
          <Key size="sm" kind="rec" onClick={() => change(sample, 'owner')}>
            Retry
          </Key>
        </div>
      ) : null}
      {view === 'member' ? (
        <div className="notice" data-st="stale">
          <State word="View only" />
          <p>{owner}’s pool is shown. Financial details are not part of this member sample.</p>
        </div>
      ) : null}
      {snapshot?.payment?.declined ? (
        <div className="notice" data-st="failed">
          <State word="Not paid" />
          <p>The sample invoice is not paid. The sample card was declined.</p>
          <A className="btn sm rec" href={billingHref('payment', sample)}>
            Replace the card
          </A>
        </div>
      ) : null}
      {cli ? (
        <pre className="cli-out mono" id="billing-cli">
          <b>$ nforge billing</b> <span className="prop">command and reply proposed · sample data</span>
          {snapshot
            ? `\npool        ${owner}, ${plan.name}, ${snapshot.pool.period.label}\nlandings    ${number(snapshot.pool.acceptedLandings)} used, ${number(plan.includedLandings)} included\nextra       ${money(extraBlock.usd, 0)} per ${extraBlock.landings}\nresets      ${snapshot.pool.period.resetAt}\n${remainingBudgetLine(landingAllowance(snapshot.pool)) ?? 'billing pool  no low-budget line applies'}\nrun allowance  separate; not reported`
            : '\nLoading the sample…'}
        </pre>
      ) : null}
      {isSummary ? (
        <>
          <div className="pf">
            <A className="lk" href={billingHref('home', sample, view)}>
              Back to the month
            </A>
          </div>
          <Region title={title[screen] ?? 'Billing'} hint="Sample data">
            {props ? (
              screen === 'plan' ? (
                <Plan {...props} />
              ) : view === 'member' ? (
                <p className="quietline">Financial details are not part of this member sample.</p>
              ) : screen === 'payment' ? (
                <Payment {...props} />
              ) : (
                <Invoices {...props} />
              )
            ) : (
              skeleton
            )}
          </Region>
        </>
      ) : (
        <div aria-busy={state.status === 'loading'}>
          <Dock
            label="Billing regions"
            regions={regions}
            layout={currentLayout}
            onLayout={setArrangement}
            onReset={reset}
          />
        </div>
      )}
    </div>
  );
}
