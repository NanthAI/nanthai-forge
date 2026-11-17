// SPDX-License-Identifier: Apache-2.0
import type { CSSProperties } from 'react';
import { plans, poolUsage, type BillingSnapshot } from './contract';
export const number = (value: number) => value.toLocaleString();
export const money = (value: number, digits = 2) =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
export const resetDay = (snapshot: BillingSnapshot) =>
  new Date(snapshot.pool.period.resetAt).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
export const vars = (values: Record<string, number>) =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [`--${key}`, value])) as CSSProperties;

export function Month({ snapshot }: { snapshot: BillingSnapshot }) {
  const p = snapshot.pool,
    u = poolUsage(p);
  const full = u.ceiling ?? Math.max(u.included, p.projectedLandings ?? p.acceptedLandings, 1);
  const used = Math.min(p.acceptedLandings, full);
  return (
    <>
      <div className="month">
        <div className="big">
          {number(p.acceptedLandings)}
          {u.extra ? '' : ` of ${number(u.included)}`} landings
          <small>
            {u.extra
              ? `${number(u.included)} included, ${number(u.extra)} extra: ${u.blocks} blocks, ${money(u.extraUsd, 0)}`
              : `used in ${p.period.label}${p.plan === 'hobby' ? '' : ', nothing extra'}`}
          </small>
        </div>
        <div
          className="pool"
          role="img"
          aria-label={`${number(p.acceptedLandings)} landings used; ${number(u.included)} included. Sample data.`}
          style={vars({ full, used, proj: Math.max(used, p.projectedLandings ?? used), ticks: 30 })}
        >
          {used > 0 ? <i className="used" /> : null}
          {p.projectedLandings !== null && p.projectedLandings > used ? <i className="est" /> : null}
          {u.included < full ? <i className="stop" style={vars({ at: u.included })} /> : null}
          <i className="stop end" />
        </div>
        <div className="poolx" style={vars({ full })} aria-hidden="true">
          <span style={vars({ at: 0 })}>
            <b>0</b>
          </span>
          {u.included < full ? (
            <span style={vars({ at: u.included })}>
              <b>{number(u.included)}</b>included
            </span>
          ) : null}
          <span className="endl">
            <b>{number(full)}</b>
            {p.plan === 'hobby' ? 'included' : 'sample limit'}
          </span>
        </div>
      </div>
      <div className="facts">
        <span>
          Resets <b>{resetDay(snapshot)}</b>
        </span>
        {p.projectedLandings === null ? null : (
          <span>
            At this pace <b>{number(p.projectedLandings)}</b> by month end
          </span>
        )}
        <span>One pool for every project {p.owner.handle} owns · unlimited people</span>
      </div>
    </>
  );
}

export function Months({ snapshot, table }: { snapshot: BillingSnapshot; table: boolean }) {
  const p = snapshot.pool;
  const rows = [
    ...snapshot.months,
    { month: `${p.period.label}, so far`, landings: p.acceptedLandings, plan: p.plan },
  ];
  const max =
    Math.max(...rows.map(r => r.landings), plans[p.plan].includedLandings, p.projectedLandings ?? 0) * 1.12;
  if (!snapshot.months.length && !p.acceptedLandings)
    return <p className="quietline">Months appear here after the first landing.</p>;
  return (
    <>
      <div id="billing-month-values">
        {table ? (
          <div className="scrollx" tabIndex={0} role="region" aria-label="Monthly landing counts">
            <table className="t">
              <caption className="sr">Monthly landing counts, sample data</caption>
              <thead>
                <tr>
                  <th scope="col">Month</th>
                  <th scope="col">Landings</th>
                  <th scope="col">Included</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.month}>
                    <td>{row.month}</td>
                    <td>{number(row.landings)}</td>
                    <td>{number(plans[row.plan].includedLandings)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <>
            <div className="fig">
              <div
                className="vb"
                role="img"
                aria-label={`Sample monthly landings: ${rows.map(r => `${r.month}: ${r.landings}`).join('. ')}. ${plans[p.plan].includedLandings} included.`}
              >
                <i className="lim" style={vars({ h: (plans[p.plan].includedLandings / max) * 100 })} />
                {rows.map((row, i) => (
                  <div className={`col${i === rows.length - 1 ? ' now' : ''}`} key={row.month}>
                    <span className="val">{number(row.landings)}</span>
                    {i === rows.length - 1 &&
                    p.projectedLandings !== null &&
                    p.projectedLandings > row.landings ? (
                      <i
                        className="est"
                        style={vars({ h: ((p.projectedLandings - row.landings) / max) * 100 })}
                      />
                    ) : null}
                    <i className="ink" style={vars({ h: (row.landings / max) * 100 })} />
                  </div>
                ))}
              </div>
              <div className="vx" aria-hidden="true">
                {rows.map(r => (
                  <span key={r.month}>
                    {r.month.slice(0, 3)}
                    {r.month.includes('so far') ? ', so far' : ''}
                  </span>
                ))}
              </div>
            </div>
            <div className="legend">
              <span>Landed</span>
              {p.projectedLandings !== null ? (
                <span>
                  <i className="est" />
                  At this pace, {number(p.projectedLandings)} by month end
                </span>
              ) : null}
              <span>{number(plans[p.plan].includedLandings)} included</span>
            </div>
          </>
        )}
      </div>
    </>
  );
}
