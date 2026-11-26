// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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

const messages = log =>
  (log.logLines ?? []).map(line => {
    const text = typeof line === 'string' ? line : (line.messages ?? []).join(' ');
    // Provider JSONL console arguments may carry one balanced single-quote pair.
    return text.startsWith("'") && text.endsWith("'") ? text.slice(1, -1) : text;
  });

// Match the entire console message, never a substring of repository/user output.
export function acceptedLandings(log) {
  if (log.error || log.cachedResult || !/^mutation$/i.test(log.udfType ?? '')) return 0;
  const counts = messages(log).flatMap(message => {
    const match = /^FORGE_ACCEPTED_LANDINGS ([1-9]\d*)$/.exec(message);
    return match ? [Number(match[1])] : [];
  });
  return counts.length === 1 && Number.isSafeInteger(counts[0]) ? counts[0] : 0;
}

/** The read-shape label of convex/ioAttribution.ts (Item 411727ba). Only a code-chosen label of the
 * same grammar is kept, and only when the call printed exactly one; its numbers stay in the log. */
export function ioAttribution(log) {
  const labels = messages(log).flatMap(message => {
    const match = /^FORGE_IO_ATTRIBUTION (\{.*\})$/.exec(message);
    if (!match) return [];
    try {
      const { label } = JSON.parse(match[1]);
      return typeof label === 'string' &&
        label.length <= 64 &&
        /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*){0,3}$/.test(label)
        ? [label]
        : [];
    } catch {
      return [];
    }
  });
  return labels.length === 1 ? labels[0] : null;
}

/** A call with a single source step cause and path owns its measured usage. Older lines had only a cause. */
export function sourceStepCause(log) {
  const attributions = new Set(
    messages(log).flatMap(message => {
      if (!/^\{"event":"forge-source-(?:step|failure)"/.test(message)) return [];
      try {
        // A failed attempt names why the step ran as `stepCause` (its `cause` is why it failed).
        const { event, cause: done, stepCause, path } = JSON.parse(message);
        const cause = event === 'forge-source-step' ? done : stepCause;
        if (typeof cause !== 'string' || !/^[a-z-]{1,32}$/.test(cause)) return [];
        return [
          [cause, ...(['v8-small', 'node-full', 'node-fast-disjoint'].includes(path) ? [path] : [])].join(
            '/',
          ),
        ];
      } catch {
        return [];
      }
    }),
  );
  return attributions.size === 1 ? `source-step/${[...attributions][0]}` : null;
}

/** Who made a call: a public function's guard (convex/cliServer.ts) prints `agent`, `cli` (a
 * person's CLI), `web` or `public`. CI reaches Convex only through its result routes, so those are
 * `ci`. Any other call is `internal`: scheduled, nested or another HTTP route, which the function
 * name tells apart. Only a code-chosen word is kept, and only when the call printed one. */
const callerKinds = Object.freeze(['agent', 'cli', 'web', 'public']);
const ciRoute = /^POST \/(?:checks|deploy)\/actions$/;
export function callerKind(log) {
  if (ciRoute.test(log.identifier)) return 'ci';
  const kinds = new Set(
    messages(log).flatMap(message => {
      const match = /^FORGE_CALLER ([a-z]+)$/.exec(message);
      return match && callerKinds.includes(match[1]) ? [match[1]] : [];
    }),
  );
  return kinds.size === 1 ? [...kinds][0] : 'internal';
}

/** Never retain arguments, results, error text or console output (beyond the code-chosen read label).
 * OCC attempts remain distinct. */
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
  const attribution = ioAttribution(log) ?? sourceStepCause(log);
  return {
    kind: 'execution',
    id,
    at,
    day,
    deployment,
    identifier: log.identifier,
    acceptedLandings: acceptedLandings(log),
    caller: callerKind(log),
    ...(attribution ? { attribution } : {}),
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
    attributions = new Map(),
    callers = new Map(),
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
    const shape = row.attribution ? `${row.identifier}#${row.attribution}` : null;
    if (shape && !attributions.has(shape))
      attributions.set(shape, {
        identifier: row.identifier,
        attribution: row.attribution,
        usage: empty(),
        knownUsage: empty(),
        missingFields: new Set(),
      });
    // Rows recorded before caller kinds existed have none; they stay out of perCaller.
    if (row.caller && !callers.has(row.caller))
      callers.set(row.caller, {
        caller: row.caller,
        usage: empty(),
        knownUsage: empty(),
        missingFields: new Set(),
      });
    for (const target of [
      dep,
      fn,
      ...(shape ? [attributions.get(shape)] : []),
      ...(row.caller ? [callers.get(row.caller)] : []),
    ]) {
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
    // Calls that printed a read-shape label, split by it; unlabelled calls stay only in perFunction.
    perAttribution: [...attributions.values()]
      .map(({ missingFields, ...shape }) => ({
        ...shape,
        missingFields: [...missingFields],
        ...costOf(shape.usage, shape.knownUsage),
      }))
      .sort((a, b) => b.knownUsd - a.knownUsd),
    // Every call by who made it (agent, cli, ci, web, public, internal): a read burst is attributed.
    perCaller: [...callers.values()]
      .map(({ missingFields, ...entry }) => ({
        ...entry,
        missingFields: [...missingFields],
        ...costOf(entry.usage, entry.knownUsage),
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
