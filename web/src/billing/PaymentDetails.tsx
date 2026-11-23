// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Payment and details (Item 7f9a23e8): card summary, invoice details, the owner-set limit on extra landings and who
// has billing. Card entry hands off to a hosted payment page: Forge holds no card fields or card secrets.
import { useMemo, useState } from 'react';
import { Key, Region, Row, State } from '../ds';
import { A } from '../app/frames';
import {
  createBillingActions,
  operationId,
  type ActionResult,
  type BillingDetails,
  type Checkout,
} from './actions';
import { defaultExtraBlocks, extraBlock, plans, poolUsage } from './contract';
import { money, number } from './figures';
import { BillingHead, type Moment, type ScreenProps } from './Head';
import { LimitControl } from './LimitControl';
import { dayMonth, limitChoices, monthlyMaximum, paymentRecovery, type LimitChoice } from './preview';
import { billingHref } from './sections';

const moments: readonly Moment[] = [
  { value: 'card', label: 'Card on file' },
  { value: 'replace', label: 'Replacing the card' },
  { value: 'expiring', label: 'Card expires soon' },
  { value: 'invalid', label: 'Tax ID not valid' },
];
const detailFields: readonly [keyof BillingDetails, string, string, string?][] = [
  [
    'billedTo',
    'Billed to',
    'organization',
    'A person’s or a company’s legal name. It appears on invoices only.',
  ],
  ['country', 'Country', 'country-name'],
  ['postcode', 'Postcode', 'postal-code'],
  ['address', 'Address', 'street-address'],
  ['taxId', 'Tax ID, optional', 'off'],
  [
    'copyTo',
    'Send a copy of each invoice to, optional',
    'off',
    'Invoices always go to the address you sign in with.',
  ],
];

export default function PaymentDetails({ snapshot, sample, view, search }: ScreenProps) {
  const step = moments.some(m => m.value === search.get('step')) ? (search.get('step') as string) : 'card';
  const actions = useMemo(() => createBillingActions(), []);
  const pool = snapshot?.pool;
  const payment = snapshot?.payment ?? null;
  const owner = pool?.owner.handle ?? '@sample-owner';
  const hobby = pool?.plan === 'hobby';
  const canEdit = view === 'owner' || view === 'manager';
  const [blocks, setBlocks] = useState<LimitChoice>(
    () =>
      limitChoices.find(c => c === (pool ? pool.extraBlocksAllowed : defaultExtraBlocks)) ??
      (pool?.extraBlocksAllowed === null ? null : defaultExtraBlocks),
  );
  const initial: BillingDetails = {
    billedTo: payment?.billedTo ?? '',
    country: payment?.country === 'Not reported' ? '' : (payment?.country ?? ''),
    postcode: '',
    address: '',
    taxId: step === 'invalid' ? 'XX123' : '',
    copyTo: '',
  };
  const [details, setDetails] = useState(initial);
  const [detailsOp, setDetailsOp] = useState(operationId);
  const [saved, setSaved] = useState<ActionResult<keyof BillingDetails> | null>(() =>
    step === 'invalid' ? actions.saveDetails({ operationId: detailsOp, details: initial }) : null,
  );
  const dirty = JSON.stringify(details) !== JSON.stringify(initial);
  const [cardOp, setCardOp] = useState(operationId);
  const [card, setCard] = useState<Checkout | null>(() =>
    step === 'replace' ? actions.replaceCard({ operationId: cardOp }) : null,
  );
  if (!pool || !snapshot)
    return (
      <BillingHead
        title="Payment and details"
        sample={sample}
        view={view}
        screen="payment"
        sentence="Loading the billing sample…"
        command="nforge billing limit"
        reply={null}
      />
    );
  const plan = plans[pool.plan];
  const usage = poolUsage(pool);
  const max = monthlyMaximum(pool.plan, blocks);
  const expires = step === 'expiring' ? '11/26' : (payment?.expires ?? '');
  const resets = dayMonth(pool.period.resetAt);
  const recovery = payment?.firstDeclinedAt
    ? paymentRecovery(payment.firstDeclinedAt, pool.period.asOf)
    : null;
  const sentence = hobby ? (
    <>
      <b>No card on file.</b> Hobby is free; a card is asked for only when you choose a paid plan.
    </>
  ) : view === 'member' ? (
    <>
      <b>Payment details are for {owner} and billing managers.</b>
    </>
  ) : step === 'expiring' ? (
    <>
      <b>
        {payment?.brand} ending {payment?.last4} expires before the next invoice.
      </b>{' '}
      The {resets} invoice would be declined.
    </>
  ) : (
    <>
      <b>
        {payment?.brand} ending {payment?.last4} pays on the 1st.
      </b>{' '}
      Extra landings stop at {blocks === null ? 'no limit' : `${blocks} ${blocks === 1 ? 'block' : 'blocks'}`}
      {max.maxUsd === null ? '.' : `: at most ${money(max.maxUsd, 0)} a month before tax.`}
    </>
  );
  const cardBody = !payment ? (
    <p className="quietline">
      No card.{' '}
      <A className="lk" href={billingHref('plan', sample, view)}>
        See plans
      </A>
    </p>
  ) : card ? (
    <div className="pad">
      <div className="foreign billing-handoff">
        <b>
          {card.state === 'declined'
            ? 'The bank declined the new card.'
            : card.state === 'paid'
              ? 'Sample: the new card would pay from the next invoice.'
              : 'Replacing the card happens on the payment page.'}
        </b>
        <span>
          {card.state === 'declined'
            ? `${payment.brand} ending ${payment.last4} still pays. Nothing was charged.`
            : card.state === 'paid'
              ? 'Nothing changed in this preview.'
              : 'Forge never sees or stores the card number. Sample: no payment page opens in this preview.'}
        </span>
      </div>
      {card.state === 'handoff' ? (
        <p className="billing-note">
          Sample: the payment page would report{' '}
          <button
            type="button"
            className="lk"
            onClick={() => setCard(actions.settle(card.operationId, 'paid'))}
          >
            card saved
          </button>{' '}
          ·{' '}
          <button
            type="button"
            className="lk"
            onClick={() => setCard(actions.settle(card.operationId, 'declined'))}
          >
            declined
          </button>
        </p>
      ) : null}
      <div className="btns">
        {card.state === 'declined' ? (
          <Key
            kind="rec"
            onClick={() => {
              const next = operationId();
              setCardOp(next);
              setCard(actions.replaceCard({ operationId: next }));
            }}
          >
            Try another card
          </Key>
        ) : null}
        <Key kind="ghost" onClick={() => setCard(null)}>
          {card.state === 'paid' ? 'Done' : `Keep ${payment.brand} ending ${payment.last4}`}
        </Key>
      </div>
    </div>
  ) : (
    <Row cols="minmax(0, 1fr) auto">
      <div>
        <div className="ttl">
          {payment.brand} ending <span className="mono">{payment.last4}</span>
        </div>
        <div className="meta">
          {payment.declined ? (
            <State word="Card declined" />
          ) : step === 'expiring' ? (
            <State word="Card expires">Expires {expires}</State>
          ) : (
            `Expires ${expires}`
          )}
        </div>
      </div>
      {canEdit ? (
        <Key
          size="sm"
          kind={payment.declined || step === 'expiring' ? 'rec' : undefined}
          onClick={() => setCard(actions.replaceCard({ operationId: cardOp }))}
        >
          Replace the card
        </Key>
      ) : null}
    </Row>
  );
  const fieldError = saved && !saved.ok ? saved : null;
  return (
    <>
      <BillingHead
        title="Payment and details"
        sample={sample}
        view={view}
        screen="payment"
        sentence={sentence}
        command="nforge billing limit"
        reply={`extra landings   ${hobby ? 'none on Hobby' : blocks === null ? 'no limit' : `up to ${blocks} blocks of ${extraBlock.landings}, ${money(extraBlock.usd, 0)} each. Landings wait at ${number(max.waitsAt ?? 0)}`}\nthis month       ${number(pool.acceptedLandings)} of ${number(usage.included)} included used; ${usage.blocks ? `${usage.blocks} extra blocks started` : 'no block started'}\nyou may          read this. nforge billing limit --blocks 4 asks ${owner}; only a person can raise what is spent\ncard, details    not shown to agents`}
        moments={moments}
        moment={step}
      />
      {recovery && payment?.declined ? (
        <div className="notice" data-st="failed">
          <State word="Card declined" />
          <p>
            <b>The card was tried on {recovery.attempts.map(a => dayMonth(a.at)).join(', ')}.</b> Landings
            carry on until {dayMonth(recovery.landingsUntil)}, then the pool goes back to Hobby’s{' '}
            {recovery.then.included} landings a month and landings wait. Nothing is deleted.
          </p>
        </div>
      ) : step === 'expiring' && payment ? (
        <div className="notice" data-st="waiting">
          <State word="Card expires" />
          <p>
            The card on file ends {expires}. Replace it before {resets} and nothing is interrupted.
          </p>
        </div>
      ) : view === 'manager' ? (
        <div className="notice" data-st="stale">
          <State word="View only">Billing manager</State>
          <p>
            {owner} gave you billing: invoices, plan, card and limit. Who else has billing, and stopping the
            plan, stay with {owner}.
          </p>
        </div>
      ) : null}
      {view === 'member' ? (
        <p className="quietline">Financial details are not part of this member sample.</p>
      ) : (
        <div className="panes billing-two">
          <div className="billing-stack">
            <Region title="Card" hint="charged on the 1st of each month">
              {cardBody}
            </Region>
            <Region title="Billing details" hint="what is printed on each new invoice">
              <div id="details" />
              {hobby ? (
                <p className="quietline">Asked for when a paid plan starts.</p>
              ) : (
                <form
                  className="pad billing-form"
                  aria-label="Billing details"
                  onSubmit={e => {
                    e.preventDefault();
                    setSaved(actions.saveDetails({ operationId: detailsOp, details }));
                  }}
                >
                  {detailFields.map(([key, label, auto, help]) => (
                    <label className="f" key={key}>
                      {label}
                      <input
                        className={`inp${key === 'taxId' ? ' mono' : ''}`}
                        name={key}
                        autoComplete={auto}
                        spellCheck={false}
                        disabled={!canEdit}
                        value={details[key]}
                        aria-invalid={fieldError?.field === key ? true : undefined}
                        aria-describedby={fieldError?.field === key ? `billing-${key}-error` : undefined}
                        onChange={e => {
                          setDetails(d => ({ ...d, [key]: e.target.value }));
                          if (saved?.ok) setDetailsOp(operationId());
                          setSaved(s => (s?.ok ? null : s));
                        }}
                      />
                      {fieldError?.field === key ? (
                        <span className="err" id={`billing-${key}-error`}>
                          {fieldError.message}
                        </span>
                      ) : help ? (
                        <span className="help">{help}</span>
                      ) : null}
                    </label>
                  ))}
                  <div className="btns">
                    <Key type="submit" disabled={!canEdit || (!dirty && !fieldError)}>
                      {fieldError ? 'Save details again' : 'Save details'}
                    </Key>
                    <span className="t3" role="status">
                      {saved?.ok
                        ? `Sample: these would apply from the ${resets} invoice. Nothing was saved.`
                        : fieldError
                          ? 'Not saved; what you typed is kept'
                          : dirty
                            ? 'Changes not saved'
                            : 'No changes'}
                    </span>
                  </div>
                </form>
              )}
            </Region>
          </div>
          <div className="billing-stack">
            <LimitControl
              plan={pool.plan}
              blocks={blocks}
              setBlocks={setBlocks}
              canEdit={canEdit}
              actions={actions}
            />
            {view === 'owner' ? (
              <Region
                title="Who can see and change billing"
                count={2}
                tools={
                  <A className="lk" href="/account/people">
                    People and teams
                  </A>
                }
              >
                <Row cols="minmax(0, 1fr) auto">
                  <div>
                    <div className="ttl mono">{owner}</div>
                    <div className="meta">Pays for this pool. Always has billing</div>
                  </div>
                  <span className="t2">owner</span>
                </Row>
                <Row cols="minmax(0, 1fr) auto">
                  <div>
                    <div className="ttl mono">@sample-manager</div>
                    <div className="meta">
                      Sees invoices, changes the plan, card and limit. Gains no source or project
                      administration
                    </div>
                  </div>
                  <span className="t2">billing manager</span>
                </Row>
                <div className="pf">
                  Agents never see the card, invoices or billing details; they can read the landing count and
                  ask for a change.
                </div>
              </Region>
            ) : null}
            {view === 'owner' && !hobby ? (
              <Region title="Stop paying">
                <Row cols="minmax(0, 1fr) auto">
                  <div>
                    <div className="ttl">Move to Hobby on {resets}</div>
                    <div className="meta">You keep {plan.name} until then. Nothing is deleted</div>
                  </div>
                  <A className="btn sm" href={billingHref('plan', sample, view, { to: 'hobby' })}>
                    Move to Hobby…
                  </A>
                </Row>
              </Region>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}
