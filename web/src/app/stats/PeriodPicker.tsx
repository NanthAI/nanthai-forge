// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Stats period picker (Item a61d3c91): the page's one picker. Last 7 or 30 days, this month, last month or a custom
// range of at most STATS_RANGE_MAX_DAYS days; the choice lives in the address and every figure follows it.
import { useState, type FormEvent } from 'react';
import { Key } from '../../ds';
import { STATS_RANGE_MAX_DAYS } from '../../../../src/stats-period';
import { PERIODS, periodSearch, type Period, type PeriodKind } from './model';

export function PeriodPicker({ period, onPeriod }: { period: Period; onPeriod: (search: string) => void }) {
  const [custom, setCustom] = useState(period.kind === 'custom');
  const [from, setFrom] = useState(period.from);
  const [to, setTo] = useState(period.to);
  const kind: PeriodKind = custom ? 'custom' : period.kind;
  const apply = (event: FormEvent) => {
    event.preventDefault();
    onPeriod(new URLSearchParams({ from, to }).toString());
  };
  return (
    <div className="stats-period">
      <label>
        <span className="sr">Period</span>
        <select
          className="inp"
          value={kind}
          onChange={event => {
            const next = event.target.value as PeriodKind;
            setCustom(next === 'custom');
            if (next !== 'custom') onPeriod(periodSearch(next));
          }}
        >
          {PERIODS.map(p => (
            <option key={p.value} value={p.value}>
              {p.text}
            </option>
          ))}
        </select>
      </label>
      {kind === 'custom' ? (
        <form className="stats-range" onSubmit={apply}>
          <label>
            <span className="sr">From</span>
            <input
              className="inp"
              type="date"
              value={from}
              max={to}
              required
              onChange={e => setFrom(e.target.value)}
            />
          </label>
          <span className="t3" aria-hidden="true">
            to
          </span>
          <label>
            <span className="sr">To</span>
            <input
              className="inp"
              type="date"
              value={to}
              min={from}
              required
              onChange={e => setTo(e.target.value)}
            />
          </label>
          <Key kind="ghost" size="sm" type="submit" title={`At most ${STATS_RANGE_MAX_DAYS} days`}>
            Show
          </Key>
        </form>
      ) : null}
    </div>
  );
}
