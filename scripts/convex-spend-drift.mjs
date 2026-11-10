// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { costOf, spendRates } from './convex-spend-model.mjs';

export function driftModel() {
  const ledger = JSON.parse(readFileSync(new URL('../src/speed-budgets.json', import.meta.url), 'utf8'));
  const value = id => {
    const n = ledger.costs.find(entry => entry.id === id)?.value;
    if (!Number.isFinite(n) || n < 0) throw Error('SPEND_DRIFT_LEDGER');
    return n;
  };
  const usage = {
    calls: ['queries', 'mutations', 'v8-actions', 'node-actions'].reduce(
      (n, k) => n + value(`landing-${k}`),
      0,
    ),
    io: value('landing-read-bytes') + value('landing-write-bytes'),
    compute: value('landing-action-gb-seconds') / 3600,
    egress: value('landing-r2-bytes-put'),
    search: 0,
  };
  const model = { usdPer1000: costOf(usage).usd * 1000, thresholdPct: ledger.costGuard.failPct };
  return { ...model, id: createHash('sha256').update(JSON.stringify(model)).digest('hex').slice(0, 16) };
}

/** One local rolling day, same scope for cost and denominator. No server reads. */
export function driftSummary(rows, now, model = driftModel(), deployments = []) {
  const windowMs = 86_400_000,
    from = now - windowMs,
    minimumLandings = 20;
  const selected = row => !deployments.length || deployments.includes(row.deployment);
  const executions = rows.filter(
    row => row.kind === 'execution' && row.at >= from && row.at <= now && selected(row),
  );
  const landings = executions.reduce((n, row) => n + (row.acceptedLandings ?? 0), 0);
  const usage = Object.fromEntries(Object.keys(spendRates).map(key => [key, 0]));
  for (const row of executions)
    for (const key of Object.keys(usage))
      usage[key] = usage[key] === null || row.usage[key] === null ? null : usage[key] + row.usage[key];
  const usd = costOf(usage).usd;
  const gaps = rows.filter(
    row => row.kind === 'gap' && row.at >= from && row.at <= now && selected(row),
  ).length;
  const usdPer1000 = landings ? (usd === null ? null : (usd * 1000) / landings) : null;
  const thresholdUsdPer1000 = model.usdPer1000 * (1 + model.thresholdPct / 100);
  const status =
    landings < minimumLandings
      ? 'too-few-landings'
      : usd === null
        ? 'unknown-usage'
        : usdPer1000 > thresholdUsdPer1000
          ? 'drift'
          : 'within-model';
  return {
    from,
    to: now,
    windowMs,
    minimumLandings,
    landings,
    usd,
    usdPer1000,
    model,
    thresholdUsdPer1000,
    status,
    gaps,
    coverage:
      'partial log stream; whole-deployment list cost over newly published non-refs receipts; model is partial guarded core, not a serving bill',
    alerts: rows.filter(row => row.kind === 'alert').map(row => row.key),
  };
}

export function driftAlerts(report) {
  const key = `landing-drift:${report.model.id}`;
  if (report.status !== 'drift' || report.alerts.includes(key)) return [];
  const title = 'P0 cost budget broken: live Convex dollars per 1,000 landings';
  const body =
    `Rolling 24h: $${report.usdPer1000.toFixed(3)}/1,000 over ${report.landings} landings; ` +
    `ledger model $${report.model.usdPer1000.toFixed(3)}, threshold +${report.model.thresholdPct}%. ` +
    `${report.gaps} detected gaps. ${report.coverage}. Decision: 3e3f9fe6. Investigate workload/coverage or update the ledger with a reason.`;
  return [
    { key, kind: 'landing-drift', priority: 'P0', title, body, issue: { key, title, body }, ...report },
  ];
}
