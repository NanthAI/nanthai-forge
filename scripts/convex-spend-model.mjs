// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { completionUsage } from './benchmark-import-monitor.mjs';

// The approved operating-budget rates, before allowances; GB means 1e9 bytes.
export const spendRates = Object.freeze({
  calls: 2 / 1e6,
  io: 0.2 / 1e9,
  search: 0.11 / 1000 / 1e9,
  compute: 0.3,
  egress: 0.12 / 1e9,
});
export const utcDay = at => new Date(at).toISOString().slice(0, 10);
const sum = (a, b) => (a === null || b === null ? null : a + b);
const empty = () => ({ calls: 0, io: 0, search: 0, compute: 0, egress: 0 });

// Match the entire console message, never a substring of repository/user output.
export function acceptedLandings(log) {
  if (log.error || log.cachedResult || !/^mutation$/i.test(log.udfType ?? '')) return 0;
  const counts = (log.logLines ?? []).flatMap(line => {
    const text = typeof line === 'string' ? line : (line.messages ?? []).join(' ');
    const match = /^FORGE_ACCEPTED_LANDINGS ([1-9]\d*)$/.exec(text);
    return match ? [Number(match[1])] : [];
  });
  return counts.length === 1 && Number.isSafeInteger(counts[0]) ? counts[0] : 0;
}

/** Never retain arguments, results, error text or console output. OCC attempts remain distinct. */
export function spendEvent(log, deployment) {
  if (log.kind === 'Progress') return null;
  if (
    log.kind !== 'Completion' ||
    !Number.isFinite(log.timestamp) ||
    log.timestamp < 0 ||
    !log.identifier ||
    typeof log.identifier !== 'string' ||
    typeof log.requestId !== 'string' ||
    typeof log.executionId !== 'string'
  )
    throw Error('SPEND_LOG_SCHEMA');
  const at = log.timestamp * 1000;
  const day = utcDay(at);
  const { usage, gbHours, missingFields } = completionUsage(log, [
    'databaseIoReadBytes',
    'databaseIoWriteBytes',
    'networkEgressBytes',
    'textIndexQueryBytes',
    'textIndexWriteQueryBytes',
  ]);
  const id = createHash('sha256')
    .update(
      JSON.stringify([
        deployment,
        log.requestId,
        log.executionId,
        log.executionTimestamp ?? log.timestamp,
        log.timestamp,
        log.occInfo?.retryCount ?? 0,
      ]),
    )
    .digest('hex');
  return {
    kind: 'execution',
    id,
    at,
    day,
    deployment,
    identifier: log.identifier,
    acceptedLandings: acceptedLandings(log),
    usage: {
      calls: 1,
      io: sum(usage.databaseIoReadBytes, usage.databaseIoWriteBytes),
      search: sum(usage.textIndexQueryBytes, usage.textIndexWriteQueryBytes),
      compute: gbHours,
      egress: usage.networkEgressBytes,
    },
    missingFields,
  };
}

export function costOf(usage, knownUsage = usage) {
  const classes = Object.fromEntries(
    Object.entries(spendRates).map(([key, rate]) => [key, usage[key] === null ? null : usage[key] * rate]),
  );
  return {
    classes,
    usd: Object.values(classes).reduce(sum, 0),
    knownUsd: Object.entries(spendRates).reduce((n, [key, rate]) => n + (knownUsage[key] ?? 0) * rate, 0),
  };
}

export function daySummary(day, rows, now = Date.now()) {
  const deployments = new Map(),
    functions = new Map(),
    gaps = [],
    alerts = new Set();
  const get = name => {
    if (!deployments.has(name))
      deployments.set(name, {
        deployment: name,
        usage: empty(),
        knownUsage: empty(),
        intervals: [],
        missingFields: new Set(),
      });
    return deployments.get(name);
  };
  for (const row of rows) {
    if (row.kind === 'alert') {
      alerts.add(row.key);
      continue;
    }
    if (row.kind === 'gap') {
      gaps.push(row);
      continue;
    }
    const dep = get(row.deployment);
    if (row.kind === 'coverage') {
      dep.intervals.push([row.from, Math.min(row.to, now)]);
      continue;
    }
    if (row.kind !== 'execution') continue;
    if (!functions.has(row.identifier))
      functions.set(row.identifier, {
        identifier: row.identifier,
        usage: empty(),
        knownUsage: empty(),
        missingFields: new Set(),
      });
    const fn = functions.get(row.identifier);
    for (const target of [dep, fn]) {
      for (const key of Object.keys(spendRates)) {
        target.usage[key] = sum(target.usage[key], row.usage[key]);
        target.knownUsage[key] += row.usage[key] ?? 0;
      }
      for (const field of row.missingFields) target.missingFields.add(field);
    }
  }
  const usage = empty(),
    knownUsage = empty();
  let projectedKnownUsd = 0;
  const detail = [...deployments.values()].map(dep => {
    for (const key of Object.keys(spendRates)) {
      usage[key] = sum(usage[key], dep.usage[key]);
      knownUsage[key] += dep.knownUsage[key];
    }
    let coveredMs = 0,
      end = 0;
    for (const [from, to] of dep.intervals.sort((a, b) => a[0] - b[0])) {
      coveredMs += Math.max(0, to - Math.max(from, end));
      end = Math.max(end, to);
    }
    const cost = costOf(dep.usage, dep.knownUsage);
    if (coveredMs > 0) projectedKnownUsd += (cost.knownUsd * 86_400_000) / coveredMs;
    return {
      deployment: dep.deployment,
      usage: dep.usage,
      knownUsage: dep.knownUsage,
      ...cost,
      coveredMs,
      missingFields: [...dep.missingFields],
    };
  });
  return {
    day,
    usage,
    knownUsage,
    ...costOf(usage, knownUsage),
    projectedKnownUsd: detail.length && detail.every(dep => dep.coveredMs > 0) ? projectedKnownUsd : null,
    deployments: detail,
    gaps,
    alerts: [...alerts],
    perFunction: [...functions.values()]
      .map(fn => ({
        identifier: fn.identifier,
        usage: fn.usage,
        knownUsage: fn.knownUsage,
        missingFields: [...fn.missingFields],
        ...costOf(fn.usage, fn.knownUsage),
      }))
      .sort((a, b) => b.knownUsd - a.knownUsd),
    coverage: 'partial: provider drops cannot be ruled out; unobserved time is unknown',
    notMetered: [
      'storage',
      'backups/exports outside function logs',
      'other deployments/projects',
      'R2',
      'allowances and invoice adjustments',
    ],
  };
}

export function pendingAlerts(report) {
  const alerts = [];
  if (report.projectedKnownUsd > 1.5)
    alerts.push({
      key: `${report.day}:daily`,
      day: report.day,
      kind: 'daily',
      projectedKnownUsd: report.projectedKnownUsd,
      thresholdUsd: 1.5,
    });
  for (const fn of report.perFunction)
    if (fn.knownUsd > 0.5)
      alerts.push({
        key: `${report.day}:function:${fn.identifier}`,
        day: report.day,
        kind: 'function',
        identifier: fn.identifier,
        knownUsd: fn.knownUsd,
        thresholdUsd: 0.5,
      });
  return alerts.filter(alert => !report.alerts.includes(alert.key));
}
