// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { fixtureInsertTable } from './work-record-domain-fixture.mjs';
import baseline from './landing-cost-write-baseline.mjs';

let recorded;
const writeAdapters = /\/(?:projectFinishReadWriter|projectLandingRequestBody|projectMetricAliasWriter)\.ts$/;

// Convex's test loader adds a sourceURL to compiled modules. Keep source function names
// and their callers so moving a function within a file does not change its trace key.
function writeOrigin() {
  const writers = [];
  let adapter;
  for (const line of new Error().stack.split('\n')) {
    const match = line.match(/^\s+at (?:async )?(?:(\S+) \()?file:\/\/.*\/(convex\/[^:]+):\d+:\d+/);
    if (!match) continue;
    const [, writer, file] = match;
    const frame = `${file}#${writer ?? '(handler)'}`;
    if (writeAdapters.test(file)) {
      adapter ??= frame;
      continue;
    }
    if (writers.at(-1) !== frame) writers.push(frame);
    if (writers.length === 2) break;
  }
  return writers.join(' ← ') || adapter;
}

function readBaseline() {
  const [header, ...lines] = baseline.trim().split('\n');
  const keys = JSON.parse(header);
  return new Map(
    lines.map(line => {
      const [row, bytes] = JSON.parse(line);
      return [row, Object.fromEntries(keys.slice(0, bytes.length).map((site, i) => [site, bytes[i]]))];
    }),
  );
}

/** Record only the selected scenario, at the fixture's metered database boundary. */
export function captureWriteSites(fixture) {
  const sites = {};
  fixture.extendContext((ctx, _, name) => {
    for (const operation of ['insert', 'patch', 'replace']) {
      const write = ctx.db[operation];
      ctx.db[operation] = (...args) => {
        const origin = writeOrigin();
        const table =
          operation === 'insert' ? fixtureInsertTable(args[0], args[1].collection) : args[0].split('-')[0];
        const site = `${name} → ${operation} ${table}${origin ? ` at ${origin}` : ''}`;
        // Raw fixture writes meter bytes synchronously before returning a promise.
        const before = ctx.meta.getTransactionMetrics();
        const result = write(...args);
        const after = ctx.meta.getTransactionMetrics();
        return Promise.all([result, before, after]).then(([value, old, current]) => {
          const bytes = current.bytesWritten.used - old.bytesWritten.used;
          sites[site] = (sites[site] ?? 0) + bytes;
          return value;
        });
      };
    }
  });
  return sites;
}

/** Also handles writers added or removed between the two measurements. */
export function writeSiteDelta(before, after) {
  const delta = {};
  for (const site of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const bytes = (after[site] ?? 0) - (before[site] ?? 0);
    if (bytes) delta[site] = bytes;
  }
  return delta;
}

// Capture diagnostics alongside the existing test run. Recording never alters the assertions or
// writes the fixture. Refresh only the affected row when its ledger pin is intentionally updated.
export function reportWriteSites(t, row, sites, failed) {
  if (process.env.FORGE_RECORD_LANDING_COST_WRITE_SITES === '1') {
    const sorted = Object.fromEntries(
      Object.keys(sites)
        .sort()
        .map(site => [site, sites[site]]),
    );
    t.diagnostic(`writeSites ${JSON.stringify([row, sorted])}`);
  }
  if (!failed) return;
  recorded ??= readBaseline();
  const before = recorded.get(row);
  if (!before) {
    t.diagnostic(`${row}: no recorded write sites; current fixture writes ${JSON.stringify(sites)}`);
    return;
  }
  const changes = Object.entries(writeSiteDelta(before, sites))
    .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
    .map(
      ([site, bytes]) =>
        `${site}: ${before[site] ?? 0} → ${sites[site] ?? 0} B (${bytes > 0 ? '+' : ''}${bytes} B)`,
    );
  t.diagnostic(
    `${row} fixture write bytes by call site\n${changes.join('\n') || 'No write-site bytes changed.'}`,
  );
}
