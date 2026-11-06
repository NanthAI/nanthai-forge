// SPDX-License-Identifier: Apache-2.0
// Shard pool claims (Issue 0ea17a29): one create-only R2 object per pool unit. The plan call
// returns a signed create-only PUT and a signed HEAD per unit; the fixed supervisor claims units
// after its kept files. No Convex call per claim. docs/operations/github-actions-checks.md#shard-pool
import { z } from 'zod';
import { networkTimeout } from './network-fetch.js';
import { maxPoolUnits } from '../scripts/shard-pool.mjs';
// Re-exported for Convex modules, which import shared code from src.
export { poolUnits } from '../scripts/shard-pool.mjs';
import type { semanticReportsSchema } from './intent-semantic-conflict.js';

export const poolClaimSchema = z
  .object({
    put: z.object({ url: z.url(), headers: z.record(z.string(), z.string()) }).strict(),
    head: z.url(),
  })
  .strict();
export const poolClaimsSchema = z.array(poolClaimSchema).max(maxPoolUnits);
export type PoolClaim = z.infer<typeof poolClaimSchema>;
/** Claim URLs outlive the plan job (30 min) plus a queued shard start; a late shard that finds
 * them expired falls back to its static group. */
export const poolClaimExpirySeconds = 2 * 3600;
/** Run-scoped, outside project content keys, so one bucket lifecycle rule on `v1/pool/` can expire them. */
export const poolClaimKey = (projectId: string, runId: string, execution: string, unit: number) =>
  `v1/pool/${projectId}/${runId}/${execution}/${unit}`;
/** The signed body: fixed, public and meaningless. Who won is told by the PUT status only. */
export const poolClaimBody = (unit: number): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(`forge-claim-v1 ${unit}\n`);

type Unit = { unit: number; home: number; files: string[] };
export type PoolOutcome = {
  /** Units this shard ran: claimed, or run without a confirmed claim (doubt). */
  ran: number[];
  /** Own units run without a confirmed claim: another shard may have run them too. */
  doubt: number[];
  /** Own units another shard claimed; the server fails the check if nobody reports their files. */
  yielded: number[];
  puts: number;
  heads: number;
  races: number;
  fallback: string | null;
};
const timeoutMs = 10_000,
  headConcurrency = 16;

/** Claim loop for one shard, after its kept files. Rules: a unit is skipped only after a clean
 * 412 on this shard's single PUT, or a HEAD that shows it exists before this shard tried it.
 * Any other outcome ends stealing and runs every own unit not seen taken (run on doubt), so a
 * misbehaving store can cause a duplicate run, never a lost one. */
export async function runShardPool(input: {
  units: Unit[];
  home: number;
  claims: PoolClaim[] | null;
  request: typeof fetch;
  run: (unit: Unit) => Promise<void>;
  /** Stop stealing (for example after the kept files could not start); own units still run. */
  steal?: boolean;
}): Promise<PoolOutcome> {
  const { units, home, claims, request, run } = input;
  const outcome: PoolOutcome = {
    ran: [],
    doubt: [],
    yielded: [],
    puts: 0,
    heads: 0,
    races: 0,
    fallback: null,
  };
  const mine = new Set<number>(),
    taken = new Set<number>();
  const own = units.filter(unit => unit.home === home);
  const execute = async (unit: Unit, doubt = false) => {
    mine.add(unit.unit);
    outcome.ran.push(unit.unit);
    if (doubt) outcome.doubt.push(unit.unit);
    await run(unit);
  };
  const unavailable = (reason: string) => {
    outcome.fallback ??= reason;
  };
  if (!claims || claims.length !== units.length) unavailable('no claim targets');
  const claim = async (unit: Unit): Promise<'mine' | 'taken' | 'error'> => {
    const target = claims![unit.unit]!;
    outcome.puts++;
    try {
      const response = await request(target.put.url, {
        method: 'PUT',
        headers: target.put.headers,
        body: poolClaimBody(unit.unit),
        redirect: 'error',
        signal: networkTimeout(timeoutMs),
      });
      await response.body?.cancel();
      if (response.ok) return 'mine';
      if (response.status === 412) return 'taken';
      return 'error';
    } catch {
      return 'error';
    }
  };
  const exists = async (unit: Unit): Promise<boolean | 'error'> => {
    outcome.heads++;
    try {
      const response = await request(claims![unit.unit]!.head, {
        method: 'HEAD',
        headers: { 'accept-encoding': 'identity' },
        redirect: 'error',
        signal: networkTimeout(timeoutMs),
      });
      await response.body?.cancel();
      return response.ok ? true : response.status === 404 ? false : 'error';
    } catch {
      return 'error';
    }
  };
  // Own units front to back: the PUT itself answers, no HEAD needed.
  for (const unit of own) {
    if (outcome.fallback) break;
    const result = await claim(unit);
    if (result === 'mine') await execute(unit);
    else if (result === 'taken') taken.add(unit.unit);
    // Our write may have landed: run it.
    else {
      unavailable('claim write failed');
      await execute(unit, true);
    }
  }
  // Steal: snapshot the units this shard has not seen taken, then take the last free unit of
  // the home with the most free units (home claims from the front, thieves from the back).
  while (!outcome.fallback && input.steal !== false) {
    const unknown = units.filter(unit => unit.home !== home && !taken.has(unit.unit) && !mine.has(unit.unit));
    if (!unknown.length) break;
    const free: Unit[] = [];
    for (let start = 0; start < unknown.length && !outcome.fallback; start += headConcurrency) {
      const page = unknown.slice(start, start + headConcurrency);
      const seen = await Promise.all(page.map(exists));
      seen.forEach((result, index) => {
        if (result === 'error') unavailable('claim read failed');
        else if (result) taken.add(page[index]!.unit);
        else free.push(page[index]!);
      });
    }
    if (outcome.fallback || !free.length) break;
    const byHome = new Map<number, Unit[]>();
    for (const unit of free) byHome.set(unit.home, [...(byHome.get(unit.home) ?? []), unit]);
    const homes = [...byHome].sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);
    // Keep taking that home's units from the back while claims succeed (no re-read between
    // them); a lost race ends the chain, and the next round re-reads.
    let claimed = false;
    for (const [, candidates] of homes) {
      for (const unit of candidates.reverse()) {
        const result = await claim(unit);
        if (result === 'mine') {
          await execute(unit);
          claimed = true;
          continue;
        }
        if (result === 'taken') {
          taken.add(unit.unit);
          outcome.races++;
        } else {
          unavailable('claim write failed');
          // Another home owns it and will run it unless our write landed; run it to be safe.
          await execute(unit, true);
        }
        break;
      }
      if (claimed || outcome.fallback) break;
    }
  }
  // Fallback: today's static plan for whatever this shard has not seen another shard take.
  // Without claim targets no shard can claim, so that is the static plan, not a doubt run.
  const static_ = !claims || claims.length !== units.length;
  for (const unit of own) if (!mine.has(unit.unit) && !taken.has(unit.unit)) await execute(unit, !static_);
  outcome.yielded = own.filter(unit => taken.has(unit.unit) && !mine.has(unit.unit)).map(unit => unit.unit);
  return outcome;
}

export const describePoolOutcome = (outcome: PoolOutcome, home: number, units: Unit[]) => {
  const own = units.filter(unit => unit.home === home).length;
  const stolen = outcome.ran.filter(unit => units[unit]?.home !== home).length;
  return (
    `Shard pool: ${units.length} units, ${own} own; ran ${outcome.ran.length - stolen} own and ${stolen} claimed from other shards; ` +
    `yielded ${outcome.yielded.length}; ${outcome.doubt.length} run without a confirmed claim (may run twice, counted once); ` +
    `${outcome.puts} claim writes, ${outcome.heads} claim reads, ${outcome.races} lost races` +
    (outcome.fallback ? `; static fallback: ${outcome.fallback}` : '')
  );
};

type Reports = z.infer<typeof semanticReportsSchema>;
/** Shard results merged by file, so a file run by two shards counts once; a pass never replaces
 * a failure (a duplicate run cannot hide a failing one). */
export function mergeShardReports(existing: Reports, incoming: Reports) {
  const merged: Reports = { ...existing };
  for (const [file, report] of Object.entries(incoming))
    merged[file] = existing[file]?.failed && !report.failed ? existing[file]! : report;
  return merged;
}
/** Files home shards yielded to the pool that no shard has reported yet. At completion each
 * becomes a failed report: a lost or forged claim can fail a check, never pass it with fewer tests. */
export function settlePoolPending(
  reports: Reports,
  pending: readonly string[],
  yielded: readonly string[],
  complete: boolean,
) {
  const open = [...new Set([...pending, ...yielded])].filter(file => !reports[file]).sort();
  if (!complete) return { reports, pending: open };
  const settled: Reports = { ...reports };
  for (const file of open)
    settled[file] = {
      failed: true,
      firstError: `POOL_UNIT_UNREPORTED: a shard yielded ${file} to the shard pool and no shard reported running it.`,
    };
  return { reports: settled, pending: [] as string[] };
}
