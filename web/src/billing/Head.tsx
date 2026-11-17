// SPDX-License-Identifier: Apache-2.0
// The billing page head: trail, answer sentence, the agent command chip and the sample-state switches.
import { useState, type ReactNode } from 'react';
import { Key } from '../ds';
import { A } from '../app/frames';
import { navigate } from '../app/router';
import { billingHref } from './sections';
import type { BillingAdapter, BillingSnapshot, BillingState } from './contract';
import { billingSamples, billingViews, type BillingSample, type BillingView } from './stub';

/** What each billing screen gets from the Billing route: the adapter's state and the sample switches. */
export type ScreenProps = {
  adapter: BillingAdapter;
  state: BillingState;
  snapshot: BillingSnapshot | null;
  sample: BillingSample;
  view: BillingView;
  search: URLSearchParams;
};

export type Moment = { value: string; label: string };
type Props = {
  title?: string;
  owner?: string;
  sample: string;
  view: string;
  screen: string;
  sentence: ReactNode;
  command: string;
  reply: string | null;
  tools?: ReactNode;
  moments?: readonly Moment[];
  moment?: string;
};
export function BillingHead({
  title,
  owner,
  sample,
  view,
  screen,
  sentence,
  command,
  reply,
  tools,
  moments,
  moment,
}: Props) {
  const [cli, setCli] = useState(false);
  const go = (next: { sample?: string; view?: string; step?: string }) =>
    navigate(
      billingHref(
        screen,
        next.sample ?? sample,
        next.view ?? view,
        next.step ? { step: next.step } : undefined,
      ),
    );
  return (
    <>
      <div className="head">
        <h1>
          {title ? (
            <>
              <A href={billingHref('home', sample, view)}>Billing</A> <span className="t3">›</span> {title}
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
        <p className="sit">{sentence}</p>
        <div className="tools">
          {tools}
          <Key
            className="cli mono"
            aria-controls="billing-cli"
            aria-expanded={cli}
            onClick={() => setCli(v => !v)}
          >
            {command}
          </Key>
          <span className="prop">Sample data · no charges</span>
        </div>
        <details className="billing-samples">
          <summary>Sample states</summary>
          <div className="btns">
            <label>
              Sample
              <select
                className="inp"
                value={sample}
                onChange={e => go({ sample: e.target.value, step: moment })}
              >
                {billingSamples.map(value => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              View
              <select className="inp" value={view} onChange={e => go({ view: e.target.value, step: moment })}>
                {billingViews.map(value => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            {moments ? (
              <label>
                Moment
                <select className="inp" value={moment} onChange={e => go({ step: e.target.value })}>
                  {moments.map(m => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        </details>
      </div>
      {cli ? (
        <pre className="cli-out mono" id="billing-cli">
          <b>$ {command}</b> <span className="prop">command and reply proposed · sample data</span>
          {`\n${reply ?? 'Loading the sample…'}`}
        </pre>
      ) : null}
    </>
  );
}
