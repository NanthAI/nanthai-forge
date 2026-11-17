// SPDX-License-Identifier: Apache-2.0
import { Fragment, useState } from 'react';
import { Key, Row, State } from '../ds';
import { A } from '../app/frames';
import {
  extraBlock,
  invoiceTotal,
  landingCountingRule,
  plans,
  type BillingInvoice,
  type BillingSnapshot,
} from './contract';
import { money, number, resetDay, vars } from './figures';

export const billingHref = (
  screen = 'home',
  sample = 'first',
  view = 'owner',
  extra?: Record<string, string>,
) =>
  `/-/account/billing?${new URLSearchParams({ sample, view, ...(screen === 'home' ? {} : { screen }), ...extra })}`;
type Props = { snapshot: BillingSnapshot; sample: string };
export function Projects({ snapshot }: Props) {
  const [shown, setShown] = useState(8);
  const rows = [...snapshot.projects.rows].sort((a, b) => b.landings - a.landings);
  if (!rows.length)
    return <p className="quietline">Project usage appears after the first accepted landing.</p>;
  return (
    <>
      <table className="t stack">
        <caption className="sr">Landings by project, sample data, most landings first</caption>
        <thead>
          <tr>
            <th scope="col">Project</th>
            <th scope="col">Landings</th>
            <th scope="col" className="l">
              Share of the month
            </th>
            <th scope="col">Last landing</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, shown).map(row => (
            <tr key={row.id} data-row="">
              <td>
                <A className="name" href={row.href} dir="auto" translate="no">
                  {row.name}
                </A>
              </td>
              <td className="amt mono">{number(row.landings)}</td>
              <td className="bar">
                <div
                  className="stick"
                  role="img"
                  aria-label={`${Math.round((row.landings / snapshot.pool.acceptedLandings) * 100)}% of the month`}
                  style={vars({ v: (row.landings / snapshot.pool.acceptedLandings) * 100 })}
                >
                  <i />
                </div>
              </td>
              <td className="t2" data-k="Last landing">
                {row.lastLanding ?? 'Not reported'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {shown < rows.length ? (
        <div className="pf">
          {shown} of {snapshot.projects.total} projects, most landings first.{' '}
          <Key kind="ghost" size="sm" onClick={() => setShown(rows.length)}>
            Show {rows.length - shown} more
          </Key>
        </div>
      ) : null}
    </>
  );
}
export function Plan({ snapshot, sample }: Props) {
  const { pool } = snapshot,
    p = plans[pool.plan];
  return (
    <>
      <Row cols="minmax(0, 1fr) auto">
        <div>
          <div className="ttl">
            {p.name}, {p.monthlyUsd ? `${money(p.monthlyUsd, 0)} a month` : 'free'}
          </div>
          <div className="meta">{number(p.includedLandings)} landings a month</div>
        </div>
        {snapshot.view !== 'member' ? (
          <A className="btn sm" href={billingHref('plan', sample)}>
            Change plan
          </A>
        ) : null}
      </Row>
      <Row cols="minmax(0, 1fr) auto">
        <div>
          <div className="ttl">Extra landings</div>
          <div className="meta">
            {money(extraBlock.usd, 0)} per {number(extraBlock.landings)} past the included{' '}
            {number(p.includedLandings)}
          </div>
        </div>
        {snapshot.view !== 'member' ? (
          <A className="btn sm ghost" href={`${billingHref('payment', sample)}#limit`}>
            Change
          </A>
        ) : null}
      </Row>
      <details className="billing-details">
        <summary>What counts as a landing?</summary>
        <p>{landingCountingRule}</p>
      </details>
      <div className="pf">
        <a className="lk" href="/docs/billing/#current-service-limits">
          Service limits
        </a>
      </div>
    </>
  );
}
export function Statement({ invoice, total = 'So far' }: { invoice: BillingInvoice | null; total?: string }) {
  if (!invoice) return <p className="quietline">No invoice. Hobby is free.</p>;
  return (
    <dl className="lines">
      {invoice.lines.map((line, i) => (
        <Fragment key={i}>
          <dt>
            {line.label}
            {line.quantity > 1 ? <small>{line.quantity} blocks</small> : null}
          </dt>
          <dd>{money(line.quantity * line.unitUsd)}</dd>
        </Fragment>
      ))}
      <dt>Tax, sample</dt>
      <dd>{money(invoice.taxUsd)}</dd>
      <dt className="sum">{total}</dt>
      <dd className="sum">{money(invoiceTotal(invoice))}</dd>
    </dl>
  );
}
export function Payment({ snapshot, sample }: Props) {
  const p = snapshot.payment;
  if (!p) return <p className="quietline">No card on file. A card is needed only for a paid plan.</p>;
  return (
    <>
      <Row cols="minmax(0, 1fr) auto">
        <div>
          <div className="ttl">
            {p.brand} ending <span className="mono">{p.last4}</span>
          </div>
          <div className="meta">{p.declined ? <State word="Card declined" /> : `Expires ${p.expires}`}</div>
        </div>
        <A className="btn sm ghost" href={billingHref('payment', sample)}>
          Replace
        </A>
      </Row>
      <Row cols="minmax(0, 1fr) auto">
        <div>
          <div className="ttl any" dir="auto">
            {p.billedTo}
          </div>
          <div className="meta">
            {p.country} · {p.taxLabel}
          </div>
        </div>
        <A className="btn sm ghost" href={`${billingHref('payment', sample)}#details`}>
          Edit
        </A>
      </Row>
    </>
  );
}
export function Invoices({ snapshot, sample }: Props) {
  const rows = snapshot.invoices?.rows ?? [];
  if (!rows.length)
    return (
      <p className="quietline">
        No invoices.{' '}
        {snapshot.pool.plan === 'hobby' ? 'Hobby is free.' : 'The first appears when a paid plan starts.'}
      </p>
    );
  return (
    <>
      {rows.slice(0, 3).map(invoice => (
        <A
          className="row billing-invoice"
          key={invoice.id}
          href={`${billingHref('invoices', sample)}&invoice=${encodeURIComponent(invoice.id)}`}
        >
          <span>
            <span className="ttl mono">{invoice.id}</span>
            <span className="meta">{invoice.issued}</span>
          </span>
          <span className="mono">{money(invoiceTotal(invoice))}</span>
          <State
            word={invoice.state === 'paid' ? 'Paid' : invoice.state === 'refunded' ? 'Refunded' : 'Not paid'}
          />
        </A>
      ))}
      <div className="pf">
        Showing {Math.min(3, rows.length)} of {snapshot.invoices?.total} invoices.{' '}
        <A className="lk" href={billingHref('invoices', sample)}>
          Open invoices
        </A>
      </div>
    </>
  );
}
export function InvoiceFoot({ snapshot }: { snapshot: BillingSnapshot }) {
  return snapshot.nextInvoice ? (
    <div className="pf">
      Sample statement for {resetDay(snapshot)}. Extra landings are billed after the month ends.
    </div>
  ) : null;
}
