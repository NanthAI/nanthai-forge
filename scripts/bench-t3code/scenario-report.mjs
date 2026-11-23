#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Queue A/B report for retained Forge cells: joins each cell's result.json with the bench
// project's receipts (one `landings` read per 30 landings of the cell window). Read-only.
//   BENCH_ROOT=... node scripts/bench-t3code/scenario-report.mjs CELL_ID... > report.json
// It compares only like with like (Item 368ac54f, guard 4): cells with a different N, scenario
// set, base or seed are refused (exit 2) and the matching accepted cell is named instead.
// Each row carries `failed` (cell-checks.mjs): a local refusal for a file the landing did not
// change, or a false SYNC_REQUIRED mark, fails the cell.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { benchRootOrExit } from './bench-root.mjs';
import { pathEvidence, cellLandings, permanentRules } from './path-evidence.mjs';
import { scenarioRole, scenarioTestPath } from './scenarios.mjs';
import { dryGroup } from './scripted.mjs';
import { cellChecks } from './cell-checks.mjs';
import { cellOutcome } from './cell-outcome.mjs';

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

/** What two compared cells must share: N, scenario set (name, version text, tasks, scripted or
 * live), base and seed. Switches are what an A/B varies, so they are not in it. */
export function compareKey(result) {
  return {
    N: result.N ?? null,
    scenario: result.scenario?.name ?? 'smoke',
    scenarioVersion: result.scenario?.about ?? null,
    tasks: [...(result.order ?? [])].sort().join(','),
    dry: Boolean(result.dry),
    base: result.base ?? null,
    seed: result.seed ?? null,
  };
}
const KEY_NAMES = { scenarioVersion: 'scenario version', tasks: 'task set', dry: 'scripted/live' };

/** Fields on which `b` differs from `a`. A base one cell did not record is unknown, not a difference. */
export function keyDifferences(a, b) {
  const ka = compareKey(a),
    kb = compareKey(b);
  return Object.keys(ka).filter(
    k => !(k === 'base' && (ka.base === null || kb.base === null)) && ka[k] !== kb[k],
  );
}

/** The accepted cell to compare `cell` with instead: same key, a complete result, listed in
 * config.acceptedCells when that list exists (else any complete cell), newest first. */
export function matchingAccepted(cell, candidates, acceptedIds = null) {
  const accepted = acceptedIds ? new Set(acceptedIds) : null;
  return (
    candidates
      .filter(c => c.cellId !== cell.cellId && cellOutcome(c) === 'complete')
      .filter(c => !accepted || accepted.has(c.cellId))
      .filter(c => keyDifferences(cell, c).length === 0)
      .sort((x, y) => String(y.startedAt ?? '').localeCompare(String(x.startedAt ?? '')))[0]?.cellId ?? null
  );
}

/** Refusal text when the cells are not like for like (null when they are). The first cell is the
 * reference; every other cell must share its key. */
export function comparisonRefusal(cells, candidates = [], acceptedIds = null) {
  const [first, ...rest] = cells;
  const problems = rest.flatMap(c => {
    const diff = keyDifferences(first, c);
    if (!diff.length) return [];
    const ka = compareKey(first),
      kb = compareKey(c);
    return [
      `${c.cellId} differs from ${first.cellId} in ${diff
        .map(k => `${KEY_NAMES[k] ?? k} (${kb[k]} vs ${ka[k]})`)
        .join(', ')}`,
    ];
  });
  if (!problems.length) return null;
  const named = cells.map(c => {
    const match = matchingAccepted(c, candidates, acceptedIds);
    return `${c.cellId}: ${match ? `compare with accepted cell ${match}` : 'no accepted cell matches (run one with the same N, scenario, base and seed)'}`;
  });
  return `BENCH_COMPARE_MISMATCH: ${problems.join('; ')}. ${named.join('; ')}.`;
}

/** Pure per-cell summary of a result and the receipts of its own Lanes; `calls` is the cell's
 * nforge-calls.jsonl (the guard checks read it); `contains(deletion, code)` says whether the
 * cell's deployed code holds a switch deletion (path-evidence.mjs permanentRules). */
export function summarizeCell(result, receipts, calls = [], contains = () => null) {
  const lanes = new Set(result.records.map(r => r.laneId).filter(Boolean));
  const own = receipts.filter(r => lanes.has(r.laneId));
  const accepted = own.reduce((a, r) => a + (r.costs?.runnerAccepted ?? 0), 0);
  const discarded = own.reduce((a, r) => a + (r.costs?.runnerDiscarded ?? 0), 0);
  const p2l = own.map(passToLand);
  const landingsOf = cellLandings(result, {
    roleOf: index => (index >= 0 ? scenarioRole(result.scenario?.name ?? 'smoke', index) : {}),
    groupOf: dryGroup,
    testPathOf: scenarioTestPath,
  });
  const laneByTask = new Map((result.records ?? []).map(r => [r.task, r.laneId]));
  const checks = cellChecks(calls, landingsOf.files, call => laneByTask.get(call.task));
  return {
    cellId: result.cellId,
    scenario: result.scenario?.name ?? 'smoke',
    ...(result.switchArm ? { switchArm: result.switchArm } : {}),
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
    // Per switch: was its queue path reached? A switch-on cell that missed it is 'path not reached'.
    // A deleted switch is on for a cell whose deployed code contains its deletion.
    paths: pathEvidence(
      own,
      result.switches?.start ?? {},
      landingsOf,
      permanentRules(result.versions?.start?.deploy?.headSha, contains),
    ),
    syncRequired: {
      replies: checks.sync.replies,
      perLanding: checks.sync.perLanding,
      falseMarks: checks.sync.falseMarks.length,
      unjudged: checks.sync.unjudged,
    },
    localRefusals: {
      total: checks.local.refusals,
      notOwnFile: checks.local.foreign.length,
      unjudged: checks.local.unjudged,
    },
    failed: checks.failures,
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

/** Whether GitHub's Forge mirror has `code` at or after `deletion` (true/false), or null when
 * the read failed. */
function containsOnGitHub(deletion, code) {
  if (![deletion, code].every(c => /^[0-9a-f]{40}$/.test(c ?? ''))) return null;
  try {
    const status = execFileSync(
      'gh',
      ['api', `repos/NanthAI/nanthai-forge/compare/${deletion}...${code}`, '--jq', '.status'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return status === 'ahead' || status === 'identical' ? true : status ? false : null;
  } catch {
    return null;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const B = benchRootOrExit();
  const config = JSON.parse(readFileSync(join(B, 'config.json'), 'utf8'));
  const root = join(B, 'ws', '.preflight');
  mkdirSync(root, { recursive: true });
  const readResult = id => {
    const file = join(B, 'runs', id, 'result.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  };
  const cells = process.argv.slice(2).map(readResult);
  const missing = process.argv.slice(2).filter((id, i) => !cells[i]);
  if (missing.length) throw Error(`BENCH_REPORT_NO_RESULT: ${missing.join(', ')}`);
  const refusal =
    cells.length > 1 &&
    comparisonRefusal(
      cells,
      readdirSync(join(B, 'runs')).flatMap(id => readResult(id) ?? []),
      config.acceptedCells ?? null,
    );
  if (refusal) {
    console.error(refusal);
    process.exit(2);
  }
  const calls = id => {
    const file = join(B, 'runs', id, 'nforge-calls.jsonl');
    return existsSync(file)
      ? readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(l => JSON.parse(l))
      : [];
  };
  const rows = cells.map(result => {
    const to = new Date(ms(result.endedAt) + 600_000).toISOString();
    return summarizeCell(
      result,
      landings(config, root, result.startedAt, to),
      calls(result.cellId),
      containsOnGitHub,
    );
  });
  console.log(JSON.stringify(rows, null, 2));
  if (rows.some(r => r.failed.length)) process.exitCode = 1;
}
