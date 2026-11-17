// SPDX-License-Identifier: Apache-2.0
// The account-wide P7 billing home and its screens. Every value is explicitly a stub; the adapter performs no IO.
import { lazy, Suspense, useState, type ReactNode } from 'react';
import { Dock, Key, Region, State, useDockLayout, type DockLayout, type DockRegion } from '../ds';
import { A } from '../app/frames';
import { navigate, useSearch } from '../app/router';
import { extraBlock, landingAllowance, plans, poolUsage, remainingBudgetLine } from './contract';
import { billingSample, billingView, createBillingStub } from './stub';
import { Month, Months, money, number, resetDay } from './figures';
import { BillingHead, type ScreenProps } from './Head';
import { InvoiceFoot, Invoices, Payment, Plan, Projects, Statement, billingHref } from './sections';
import './billing.css';

/** Each billing screen loads with its address (`screen=`), never with the home. */
const screens = {
  plan: lazy(() => import('./ChangePlan')),
  invoices: lazy(() => import('./InvoiceHistory')),
  payment: lazy(() => import('./PaymentDetails')),
  limit: lazy(() => import('./LimitStates')),
};

const layout: DockLayout = {
  top: ['month'],
  a: ['projects', 'months'],
  b: ['plan', 'next', 'pay', 'invoices'],
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
  const view = billingView(search.get('view'));
  const screen = search.get('screen') ?? 'home';
  const adapter = createBillingStub(sample, view);
  const state = adapter.read();
  const snapshot =
    state.status === 'ready' ? state.snapshot : state.status === 'error' ? state.previous : null;
  const props: ScreenProps = { adapter, state, snapshot, sample, view, search };
  const Screen = Object.hasOwn(screens, screen) ? screens[screen as keyof typeof screens] : null;
  return (
    <div className="billing">
      {Screen ? (
        <Suspense fallback={skeleton}>
          <Screen key={[screen, sample, view, search.get('step'), search.get('to')].join('.')} {...props} />
        </Suspense>
      ) : (
        <BillingHome {...props} />
      )}
    </div>
  );
}

function BillingHome({ state, snapshot, sample, view }: ScreenProps) {
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
  return (
    <>
      <BillingHead
        owner={owner}
        sample={sample}
        view={view}
        screen="home"
        sentence={head}
        command="nforge billing"
        reply={
          snapshot
            ? `pool        ${owner}, ${plan.name}, ${snapshot.pool.period.label}\nlandings    ${number(snapshot.pool.acceptedLandings)} used, ${number(plan.includedLandings)} included\nextra       ${money(extraBlock.usd, 0)} per ${extraBlock.landings}\nresets      ${snapshot.pool.period.resetAt}\n${remainingBudgetLine(landingAllowance(snapshot.pool)) ?? 'billing pool  no low-budget line applies'}\nrun allowance  separate; not reported`
            : null
        }
        tools={
          view === 'owner' || view === 'manager' ? (
            <A className="btn" href={billingHref('plan', sample, view)}>
              Change plan
            </A>
          ) : null
        }
      />
      {state.status === 'error' ? (
        <div className="notice" data-st="failed" role="alert">
          <State word="Not seen" />
          <p>{state.message}</p>
          <Key size="sm" kind="rec" onClick={() => navigate(billingHref('home', sample, 'owner'))}>
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
          <A className="btn sm rec" href={billingHref('payment', sample, view)}>
            Replace the card
          </A>
        </div>
      ) : null}
      <div aria-busy={state.status === 'loading'}>
        <Dock
          label="Billing regions"
          regions={regions}
          layout={currentLayout}
          onLayout={setArrangement}
          onReset={reset}
        />
      </div>
    </>
  );
}
