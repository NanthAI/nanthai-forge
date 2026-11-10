// SPDX-License-Identifier: Apache-2.0
import { spendRates } from './convex-spend-model.mjs';

const DAY = 86_400_000;
export const planClasses = Object.freeze({
  calls: { unit: 'calls', scale: 1 },
  io: { unit: 'GB', scale: 1e9 },
  egress: { unit: 'GB', scale: 1e9 },
  compute: { unit: 'GB-hours', scale: 1 },
  search: { unit: 'query-GB', scale: 1e9 },
  databaseStorage: { unit: 'GB (storage snapshot)', scale: null },
  fileStorage: { unit: 'GB (storage snapshot)', scale: null },
});
const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const total = values => values.reduce((n, v) => n + (v ?? 0), 0);
const add = (a, b) => (a === null || b === null ? null : a + b);
const excess = (use, allowance, rate) =>
  use === null ? null : use <= allowance ? 0 : rate === null ? null : (use - allowance) * rate;
const stamp = value =>
  typeof value === 'string' &&
  /Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString().startsWith(value.slice(0, -1));

/** Config is the billing authority; prices/allowances are never fetched or inferred from a plan name. */
export function spendPlan(value) {
  if (value === undefined) return null;
  const allowed = [
    'name',
    'monthlyUsd',
    'periodStart',
    'renewalDay',
    'prorateFirstPeriod',
    'allowances',
    'overageAlertUsd',
    'overageRates',
    'storageUsage',
  ];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(key => !allowed.includes(key)) ||
    typeof value.name !== 'string' ||
    !value.name ||
    !finite(value.monthlyUsd) ||
    !stamp(value.periodStart) ||
    !Number.isInteger(value.renewalDay) ||
    value.renewalDay < 1 ||
    value.renewalDay > 31 ||
    (value.prorateFirstPeriod !== undefined && typeof value.prorateFirstPeriod !== 'boolean') ||
    !value.allowances ||
    Object.keys(value.allowances).some(key => !Object.hasOwn(planClasses, key)) ||
    Object.keys(planClasses).some(key => !finite(value.allowances[key])) ||
    (value.overageAlertUsd !== undefined && !finite(value.overageAlertUsd))
  )
    throw Error('SPEND_PLAN_CONFIG');
  if (
    value.overageRates !== undefined &&
    (!value.overageRates || typeof value.overageRates !== 'object' || Array.isArray(value.overageRates))
  )
    throw Error('SPEND_PLAN_CONFIG');
  if (
    value.storageUsage !== undefined &&
    (!value.storageUsage || typeof value.storageUsage !== 'object' || Array.isArray(value.storageUsage))
  )
    throw Error('SPEND_PLAN_CONFIG');
  for (const [key, rate] of Object.entries(value.overageRates ?? {}))
    if (!Object.hasOwn(planClasses, key) || !finite(rate)) throw Error('SPEND_PLAN_CONFIG');
  if (value.storageUsage) {
    if (
      !stamp(value.storageUsage.asOf) ||
      Object.keys(value.storageUsage).some(key => !['asOf', 'databaseStorage', 'fileStorage'].includes(key))
    )
      throw Error('SPEND_PLAN_CONFIG');
    for (const key of ['databaseStorage', 'fileStorage'])
      if (value.storageUsage[key] !== undefined && !finite(value.storageUsage[key]))
        throw Error('SPEND_PLAN_CONFIG');
  }
  return {
    ...value,
    prorateFirstPeriod: value.prorateFirstPeriod ?? true,
    overageAlertUsd: value.overageAlertUsd ?? 25,
  };
}

/** Calendar renewals clamp short months, then return to the configured day next month. */
export function billingPeriod(plan, now = Date.now()) {
  const initial = Date.parse(plan.periodStart),
    date = new Date(now);
  if (now < initial) throw Error('SPEND_PLAN_NOT_STARTED');
  const anchor = month =>
    Date.UTC(
      date.getUTCFullYear(),
      month,
      Math.min(plan.renewalDay, new Date(Date.UTC(date.getUTCFullYear(), month + 1, 0)).getUTCDate()),
    );
  const month = date.getUTCMonth() + (now >= anchor(date.getUTCMonth()) ? 1 : 0);
  const end = anchor(month),
    cycleStart = anchor(month - 1),
    start = Math.max(initial, cycleStart);
  return {
    start,
    end,
    cycleStart,
    allowanceFactor: plan.prorateFirstPeriod ? (end - start) / (end - cycleStart) : 1,
    elapsedDays: (now - start) / DAY,
    days: (end - start) / DAY,
  };
}

/** Only intersecting numeric evidence belongs to the billing period; never rewrite the ledger. */
export function periodRows(rows, from, to) {
  return rows.flatMap(row => {
    if (row.kind === 'gap' && row.reason === 'torn-or-invalid-journal-record') return [row];
    if (row.kind === 'coverage') {
      const start = Math.max(from, row.from),
        end = Math.min(to, row.to);
      return start < end ? [{ ...row, from: start, to: end }] : [];
    }
    return Number.isFinite(row.at) &&
      row.at >= from &&
      (row.kind === 'execution' ? row.at < to : row.at <= to)
      ? [row]
      : [];
  });
}

export function billingSummary(plan, reports, now = Date.now(), expectedDeployments = []) {
  const period = billingPeriod(plan, now),
    deployments = new Map(),
    functions = new Map(),
    alerts = new Set();
  const usage = Object.fromEntries(Object.keys(spendRates).map(key => [key, 0]));
  const known = { ...usage },
    gaps = [];
  for (const report of reports) {
    gaps.push(...report.gaps);
    for (const key of report.alerts) alerts.add(key);
    for (const key of Object.keys(spendRates)) {
      usage[key] = add(usage[key], report.usage[key]);
      known[key] += report.knownUsage[key];
    }
    for (const dep of report.deployments) {
      if (!deployments.has(dep.deployment))
        deployments.set(dep.deployment, {
          coveredMs: 0,
          usage: Object.fromEntries(Object.keys(spendRates).map(k => [k, 0])),
        });
      const target = deployments.get(dep.deployment);
      target.coveredMs += dep.coveredMs;
      for (const key of Object.keys(spendRates)) target.usage[key] += dep.knownUsage[key];
    }
    for (const fn of report.perFunction) {
      if (!functions.has(fn.identifier))
        functions.set(fn.identifier, {
          identifier: fn.identifier,
          knownUsage: Object.fromEntries(Object.keys(spendRates).map(k => [k, 0])),
        });
      for (const key of Object.keys(spendRates))
        functions.get(fn.identifier).knownUsage[key] += fn.knownUsage[key];
    }
  }
  const unobserved = [...new Set([...expectedDeployments, ...deployments.keys()])].filter(
    name => !deployments.get(name)?.coveredMs,
  );
  const missing = [],
    classes = {};
  for (const [key, { unit, scale }] of Object.entries(planClasses)) {
    const storage = scale === null;
    const snapshot = plan.storageUsage;
    const snapshotValid =
      snapshot && Date.parse(snapshot.asOf) >= period.start && Date.parse(snapshot.asOf) <= now;
    const used = storage
      ? snapshotValid && finite(snapshot[key])
        ? snapshot[key]
        : null
      : usage[key] === null
        ? null
        : usage[key] / scale;
    const knownUsed = storage ? used : known[key] / scale;
    const rate = plan.overageRates?.[key] ?? (storage ? null : spendRates[key] * scale);
    const allowance = plan.allowances[key] * period.allowanceFactor;
    // Scale watched rates across the WHOLE period, including unwatched earlier time. That time
    // remains unknown in observed usage; a late start must not make the projection artificially cheap.
    const samples = [...deployments.values()].filter(dep => dep.coveredMs > 0);
    const projectedKnown = storage
      ? used
      : samples.length
        ? Math.max(
            knownUsed,
            total(samples.map(dep => (dep.usage[key] / scale / dep.coveredMs) * (period.end - period.start))),
          )
        : knownUsed > 0
          ? knownUsed
          : null;
    const projected = used === null || (!storage && unobserved.length) ? null : projectedKnown;
    if (used === null)
      missing.push(
        `${key}: usage unknown${storage ? ' (not in function logs; optional storageUsage snapshot)' : ' (missing provider fields)'}`,
      );
    if (excess(knownUsed, allowance, rate) === null && knownUsed !== null)
      missing.push(`${key}: overage rate unknown`);
    classes[key] = {
      unit,
      usageKind: storage ? 'snapshot, not cumulative monthly use' : 'captured month-to-date',
      observedUsage: used,
      knownUsage: knownUsed,
      monthlyAllowance: plan.allowances[key],
      allowance,
      normalDailyAllowance: storage ? null : plan.allowances[key] / 30,
      periodDailyAllowance: storage ? null : allowance / period.days,
      allowanceToDate: storage ? null : (allowance * period.elapsedDays) / period.days,
      overageRate: rate,
      overageUsd: excess(used, allowance, rate),
      knownOverageUsd: excess(knownUsed, allowance, rate),
      listRateUsd: storage ? null : knownUsed * spendRates[key] * scale,
      projectedUsage: projected,
      projectedKnownUsage: projectedKnown,
      projectedKnownOverageUsd: excess(projectedKnown, allowance, rate),
      ...(storage ? { asOf: snapshotValid ? snapshot.asOf : null } : {}),
    };
  }
  if (!deployments.size) missing.push('No watched log sample in this period');
  if (unobserved.length) missing.push(`Unwatched deployments: ${unobserved.join(', ')}`);
  for (const [name, dep] of deployments)
    if (dep.coveredMs < now - period.start) missing.push(`${name}: earlier/unwatched time remains unknown`);
  if (gaps.length) missing.push(`${gaps.length} recorded log gap(s); observed usage is incomplete`);
  const detail = Object.values(classes);
  const perFunction = [...functions.values()]
    .map(fn => ({
      identifier: fn.identifier,
      listRateUsd: total(Object.keys(spendRates).map(key => fn.knownUsage[key] * spendRates[key])),
      // Shared allowances belong to the team, never independently to every function. This is
      // proportional attribution of observed overage, not a marginal price or subscription share.
      allocatedOverageUsd: total(
        Object.keys(spendRates).map(key =>
          known[key] ? (fn.knownUsage[key] / known[key]) * (classes[key].knownOverageUsd ?? 0) : 0,
        ),
      ),
    }))
    .sort((a, b) => b.listRateUsd - a.listRateUsd);
  return {
    name: plan.name,
    period: {
      ...period,
      start: new Date(period.start).toISOString(),
      end: new Date(period.end).toISOString(),
      cycleStart: new Date(period.cycleStart).toISOString(),
    },
    subscriptionMonthlyUsd: plan.monthlyUsd,
    classes,
    knownOverageUsd: total(detail.map(row => row.knownOverageUsd)),
    projectedKnownOverageUsd: total(detail.map(row => row.projectedKnownOverageUsd)),
    projectedOverageUsd: detail.some(
      row => row.projectedUsage === null || row.projectedKnownOverageUsd === null,
    )
      ? null
      : total(detail.map(row => row.projectedKnownOverageUsd)),
    listRateUsd: total(perFunction.map(fn => fn.listRateUsd)),
    perFunction,
    top10: perFunction.slice(0, 10),
    missing,
    gaps: gaps.length,
    alerts: [...alerts],
    coverage: 'partial: captured function logs and optional storage snapshots, not a complete team invoice',
    overageAlertUsd: plan.overageAlertUsd,
  };
}

export function planAlerts(report) {
  const period = report.period.start,
    alerts = [];
  if (report.projectedKnownOverageUsd > report.overageAlertUsd)
    alerts.push({
      key: `${period}:overage`,
      kind: 'month-overage',
      projectedOverageUsd: report.projectedKnownOverageUsd,
      thresholdUsd: report.overageAlertUsd,
    });
  for (const key of ['io', 'egress']) {
    const row = report.classes[key];
    if (row.projectedKnownUsage > row.allowance)
      alerts.push({
        key: `${period}:${key}`,
        kind: 'allowance',
        class: key,
        projectedUsage: row.projectedKnownUsage,
        allowance: row.allowance,
        unit: row.unit,
      });
  }
  if (report.missing.length)
    alerts.push({ key: `${period}:coverage`, kind: 'billing-coverage', missing: report.missing });
  return alerts
    .filter(alert => !report.alerts.includes(alert.key))
    .map(alert => ({
      ...alert,
      periodStart: period,
      periodEnd: report.period.end,
      coverage: report.coverage,
    }));
}
