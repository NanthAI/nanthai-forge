// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Invoices (Item 989c5695): the account's invoices, one statement per invoice, and the corrected-invoice request.
// A phone shows the list or the selected invoice. Downloads and requests use the stub action contract; nothing is sent.
import { useMemo, useState } from 'react';
import { Key, Region, State } from '../ds';
import { A } from '../app/frames';
import { navigate } from '../app/router';
import { createBillingActions, operationId, type CorrectionField } from './actions';
import { invoiceTotal, type BillingInvoice } from './contract';
import { money } from './figures';
import { BillingHead, type Moment, type ScreenProps } from './Head';
import { dayMonth, paymentRecovery } from './preview';
import { billingHref, Statement } from './sections';

const moments: readonly Moment[] = [
  { value: 'sent', label: 'Correction goes through' },
  { value: 'fails', label: 'Correction fails once' },
];
const word = (s: BillingInvoice['state']) =>
  s === 'paid' ? 'Paid' : s === 'refunded' ? 'Refunded' : 'Not paid';
const fields: readonly [CorrectionField, string][] = [
  ['billedTo', 'The name billed'],
  ['address', 'The address'],
  ['taxId', 'The tax ID'],
  ['other', 'Something else'],
];

function Correction({ invoice, fails }: { invoice: BillingInvoice; fails: boolean }) {
  const actions = useMemo(() => createBillingActions({ correctionFailsOnce: fails }), [fails]);
  const [op] = useState(operationId);
  const [field, setField] = useState<CorrectionField>('billedTo');
  const [text, setText] = useState('');
  const [result, setResult] = useState<ReturnType<typeof actions.requestCorrection> | null>(null);
  if (result?.ok)
    return (
      <p className="quietline" role="status">
        Sample: the request for <span className="mono">{invoice.id}</span> would reach billing, which issues a
        credit note and a corrected invoice. Nothing is sent in this preview.
      </p>
    );
  return (
    <form
      className="pad billing-form"
      aria-label={`Ask for a corrected ${invoice.id}`}
      onSubmit={e => {
        e.preventDefault();
        setResult(actions.requestCorrection({ operationId: op, invoiceId: invoice.id, field, text }));
      }}
    >
      <label className="f">
        What is wrong
        <select className="inp" value={field} onChange={e => setField(e.target.value as CorrectionField)}>
          {fields.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="f">
        What it should say
        <textarea
          className="inp"
          rows={3}
          value={text}
          aria-invalid={result && !result.ok ? true : undefined}
          aria-describedby={result && !result.ok ? 'billing-correction-error' : undefined}
          onChange={e => setText(e.target.value)}
        />
        {result && !result.ok ? (
          <span className="err" id="billing-correction-error" role="alert">
            {result.message}
          </span>
        ) : null}
      </label>
      <div className="btns">
        <Key type="submit" kind="rec">
          {result && !result.ok && result.error === 'provider-unavailable'
            ? 'Send the request again'
            : 'Send the request'}
        </Key>
      </div>
    </form>
  );
}

export default function InvoiceHistory({ adapter, state, snapshot, sample, view, search }: ScreenProps) {
  const step = search.get('step') === 'fails' ? 'fails' : 'sent';
  const [more, setMore] = useState<BillingInvoice[]>([]);
  const [cursor, setCursor] = useState(snapshot?.invoices?.nextCursor ?? null);
  const [asking, setAsking] = useState(false);
  const [download, setDownload] = useState<string | null>(null);
  const providerDown = state.status === 'error';
  const rows = [...(snapshot?.invoices?.rows ?? []), ...more];
  const total = snapshot?.invoices?.total ?? 0;
  const picked = search.get('invoice');
  const selected = rows.find(i => i.id === picked) ?? rows[0];
  const owner = snapshot?.pool.owner.handle ?? '@sample-owner';
  const unpaid = rows.filter(i => i.state === 'unpaid');
  const recovery = snapshot?.payment?.firstDeclinedAt
    ? paymentRecovery(snapshot.payment.firstDeclinedAt, snapshot.pool.period.asOf)
    : null;
  const paid = rows.filter(i => i.state === 'paid').reduce((n, i) => n + invoiceTotal(i), 0);
  const sentence = !snapshot ? (
    'Loading the billing sample…'
  ) : view === 'member' ? (
    <>
      <b>Invoices are for {owner} and billing managers.</b>
    </>
  ) : !total ? (
    <>
      <b>No invoices.</b>{' '}
      {snapshot.pool.plan === 'hobby' ? 'Hobby is free.' : 'The first appears when a paid plan starts.'}
    </>
  ) : unpaid.length ? (
    <>
      <b>
        {unpaid.length === 1 ? '1 invoice is' : `${unpaid.length} invoices are`} not paid:{' '}
        {money(unpaid.reduce((n, i) => n + invoiceTotal(i), 0))}.
      </b>{' '}
      {recovery ? `Landings carry on until ${dayMonth(recovery.landingsUntil)}.` : null}
    </>
  ) : (
    <>
      <b>
        {total} invoices{rows.every(i => i.state === 'paid') ? ', all paid' : ''}.
      </b>{' '}
      {money(paid)} paid in the invoices shown.
      {snapshot.nextInvoice
        ? ` The next is ${dayMonth(snapshot.pool.period.resetAt)}, ${money(invoiceTotal(snapshot.nextInvoice))} so far.`
        : ''}
    </>
  );
  const open = (id: string) =>
    navigate(`${billingHref('invoices', sample, view)}&invoice=${encodeURIComponent(id)}`, { replace: true });
  return (
    <>
      <BillingHead
        title="Invoices"
        sample={sample}
        view={view}
        screen="invoices"
        sentence={sentence}
        command="nforge billing invoices"
        reply={
          !snapshot
            ? null
            : rows.length
              ? `${rows
                  .slice(0, 4)
                  .map(
                    i =>
                      `${i.id.padEnd(14)}${i.issued.padEnd(13)}${money(invoiceTotal(i)).padStart(10)}   ${word(i.state).toLowerCase()}`,
                  )
                  .join(
                    '\n',
                  )}${total > 4 ? `\n… ${total - 4} more: add --all` : ''}\nyou may   read these if ${owner} made you a billing manager`
              : 'none      no invoices'
        }
        moments={moments}
        moment={step}
      />
      {providerDown ? (
        <div className="notice" data-st="failed" role="alert">
          <State word="Not seen">Could not load</State>
          <p>
            The payment provider did not answer. The list is shown as last loaded; PDFs cannot be downloaded
            until it answers. Nothing was charged or changed.
          </p>
          <Key size="sm" kind="rec" onClick={() => navigate(billingHref('invoices', sample, 'owner'))}>
            Retry
          </Key>
        </div>
      ) : unpaid[0] && recovery ? (
        <div className="notice" data-st="failed">
          <State word="Not paid" />
          <p>
            <b>
              {money(invoiceTotal(unpaid[0]))}, invoice <span className="mono">{unpaid[0].id}</span>.
            </b>{' '}
            If it is still unpaid on {dayMonth(recovery.landingsUntil)}, the pool goes back to Hobby’s{' '}
            {recovery.then.included} landings a month and landings wait. Nothing is deleted.
          </p>
          <A className="btn sm rec" href={billingHref('payment', sample, view)}>
            Replace the card
          </A>
        </div>
      ) : view === 'manager' ? (
        <div className="notice" data-st="stale">
          <State word="View only">Billing manager</State>
          <p>
            You see {owner}’s invoices, plan, card and limit. Projects, source and people stay with {owner}.
          </p>
        </div>
      ) : null}
      {state.status === 'loading' ? (
        <div className="billing-loading" aria-busy="true" aria-label="Loading invoices">
          {[0, 1, 2, 3, 4, 5].map(n => (
            <div className="sk" key={n} />
          ))}
        </div>
      ) : view === 'member' || !snapshot ? (
        <p className="quietline">Financial details are not part of this member sample.</p>
      ) : !rows.length ? (
        <div className="empty">
          <h3>No invoices</h3>
          <p>An invoice appears here the day a paid plan starts, then on the 1st of each month.</p>
          <A className="btn" href={billingHref('plan', sample, view)}>
            See plans
          </A>
        </div>
      ) : (
        <div className={`panes billing-two billing-inv${picked ? ' picked' : ''}`}>
          <Region title="Invoices" count={total} hint="newest first">
            <table className="t stack billing-invt">
              <caption className="sr">Invoices, sample data, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Invoice</th>
                  <th scope="col" className="l">
                    Issued
                  </th>
                  <th scope="col" className="l">
                    For
                  </th>
                  <th scope="col">Total</th>
                  <th scope="col" className="l">
                    State
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(i => (
                  <tr key={i.id} data-row="" className={i === selected ? 'sel' : undefined}>
                    <td>
                      <a
                        className="name mono"
                        href={`${billingHref('invoices', sample, view)}&invoice=${encodeURIComponent(i.id)}`}
                        aria-current={i === selected ? 'true' : undefined}
                        translate="no"
                        onClick={e => {
                          e.preventDefault();
                          setAsking(false);
                          setDownload(null);
                          open(i.id);
                        }}
                      >
                        {i.id}
                      </a>
                    </td>
                    <td className="l t2">{i.issued}</td>
                    <td className="l what">{i.period}</td>
                    <td className="amt mono">{money(invoiceTotal(i))}</td>
                    <td className="l">
                      <State word={word(i.state)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {cursor ? (
              <div className="pf">
                Showing {rows.length} of {total}.{' '}
                <Key
                  size="sm"
                  kind="ghost"
                  onClick={() => {
                    const next = adapter.invoices(cursor);
                    setMore(m => [...m, ...next.rows]);
                    setCursor(next.nextCursor);
                  }}
                >
                  Show {Math.min(24, total - rows.length)} more
                </Key>
              </div>
            ) : null}
          </Region>
          {selected ? (
            <Region title={selected.id} hint={`issued ${selected.issued}`}>
              <div className="pf billing-back">
                <A className="lk" href={billingHref('invoices', sample, view)}>
                  All invoices
                </A>
              </div>
              <div className="billing-total">
                <State word={word(selected.state)} />
                <span className="big">{money(invoiceTotal(selected))}</span>
                <span className="t2">For {selected.period}</span>
              </div>
              <Statement invoice={selected} total="Total" />
              <dl className="kv">
                <dt>Issued</dt>
                <dd>{selected.issued}</dd>
                <dt>Billed to</dt>
                <dd dir="auto">{snapshot.payment?.billedTo ?? 'Not reported'}</dd>
                <dt>Tax ID</dt>
                <dd>Not reported</dd>
              </dl>
              <div className="pad btns">
                <Key
                  disabled={providerDown}
                  onClick={() => setDownload(downloadWords(selected.id, providerDown))}
                >
                  Download PDF
                </Key>
                {selected.state === 'unpaid' ? (
                  <A className="btn" href={billingHref('payment', sample, view)}>
                    Replace the card
                  </A>
                ) : null}
              </div>
              {download ? (
                <p className="quietline" role="status">
                  {download}
                </p>
              ) : null}
              <div className="pf">
                An issued invoice cannot be changed. Billing details apply to the next one.{' '}
                <Key size="sm" kind="ghost" aria-expanded={asking} onClick={() => setAsking(v => !v)}>
                  Ask for a corrected invoice
                </Key>
              </div>
              {asking ? (
                <Correction key={`${selected.id}.${step}`} invoice={selected} fails={step === 'fails'} />
              ) : null}
            </Region>
          ) : null}
        </div>
      )}
    </>
  );
}

function downloadWords(id: string, providerDown: boolean) {
  const result = createBillingActions({ providerDown }).download(id);
  return result.reason === 'provider-unavailable'
    ? 'PDFs cannot be downloaded until the payment provider answers.'
    : `Sample: no PDF exists for ${id} in this preview.`;
}
