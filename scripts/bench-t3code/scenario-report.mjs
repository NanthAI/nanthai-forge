#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Queue A/B report for retained Forge cells: joins each cell's result.json with the bench
// project's receipts (one `landings` read per 30 landings of the cell window). Read-only.
//   BENCH_ROOT=... node scripts/bench-t3code/scenario-report.mjs CELL_ID... > report.json
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { benchRootOrExit } from './bench-root.mjs';

const ms = value => Date.parse(value);
export const quantile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * p,
    low = Math.floor(at);
  return sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * (at - low);
};

/** Seconds from a landing's first passing check to its commit (null without a passed check). */
export function passToLand(receipt) {
  const first = receipt.heldAfterCheck?.[0]?.from;
  return first && receipt.committedAt ? (ms(receipt.committedAt) - ms(first)) / 1000 : null;
}

/** Pure per-cell summary of a result and the receipts of its own Lanes. */
export function summarizeCell(result, receipts) {
  const lanes = new Set(result.records.map(r => r.laneId).filter(Boolean));
  const own = receipts.filter(r => lanes.has(r.laneId));
  const accepted = own.reduce((a, r) => a + (r.costs?.runnerAccepted ?? 0), 0);
  const discarded = own.reduce((a, r) => a + (r.costs?.runnerDiscarded ?? 0), 0);
  const p2l = own.map(passToLand);
  return {
    cellId: result.cellId,
    scenario: result.scenario?.name ?? 'smoke',
    switches: result.switches?.start ?? null,
    landed: result.landed,
    receipts: own.length,
    voided: result.voided ?? [],
    wallSeconds: result.wallSecondsToAllLanded ?? null,
    passToLandP50: quantile(p2l, 0.5),
    passToLandP90: quantile(p2l, 0.9),
    passToLandMissing: p2l.filter(v => v === null).length,
    attemptsPerLanding: own.length
      ? own.reduce((a, r) => a + (r.costs?.attempts ?? 0), 0) / own.length
      : null,
    recompositions: own.reduce((a, r) => a + (r.recomposeCount ?? 0), 0),
    runnerAcceptedMin: accepted,
    runnerDiscardedMin: discarded,
    wastePercent: accepted + discarded ? (100 * discarded) / (accepted + discarded) : null,
    ciBilledMinutes: result.ci?.billedMinutes ?? null,
    convexExecutions: result.convex?.projectExecutions ?? null,
    convexUsd: result.convex?.costUsd ?? null,
    convexUsdPer1000:
      result.convex?.costUsd != null && own.length ? (1000 * result.convex.costUsd) / own.length : null,
  };
}

function landings(config, root, from, to) {
  const out = [];
  let cursor;
  for (let page = 0; page < 20; page++) {
    const body = {
      url: config.forge.url,
      projectId: config.forge.projectId,
      from,
      to,
      limit: 30,
      ...(cursor ? { cursor } : {}),
    };
    const text = execFileSync(
      '/usr/local/bin/node',
      [config.forge.cli, 'agent', root, 'landings', JSON.stringify(body)],
      {
        encoding: 'utf8',
        maxBuffer: 64 << 20,
      },
    );
    const reply = JSON.parse(
      text
        .split('\n')
        .filter(l => l.startsWith('{'))
        .at(-1),
    );
    if (reply.error) throw Error(`landings: ${reply.error.code}`);
    out.push(...reply.result.landings);
    cursor = reply.result.cursor ?? reply.result.nextCursor;
    if (!cursor) break;
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const B = benchRootOrExit();
  const config = JSON.parse(readFileSync(join(B, 'config.json'), 'utf8'));
  const root = join(B, 'ws', '.preflight');
  mkdirSync(root, { recursive: true });
  const cells = process.argv
    .slice(2)
    .map(id => JSON.parse(readFileSync(join(B, 'runs', id, 'result.json'), 'utf8')));
  const rows = cells.map(result => {
    const to = new Date(ms(result.endedAt) + 600_000).toISOString();
    return summarizeCell(result, landings(config, root, result.startedAt, to));
  });
  console.log(JSON.stringify(rows, null, 2));
}
