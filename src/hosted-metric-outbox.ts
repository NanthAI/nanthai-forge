// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ForgeError } from './errors.js';
import { metricErrorCodes } from './self-metrics-journal.js';
import {
  CALLER_RECEIPT_BATCH,
  callerReceiptSchema,
  cliProvenanceSchema,
  type CallerReceipt,
  type CliProvenance,
} from './self-metric-receipts.js';
import { callerReceiptFile } from './hosted-metric-outbox-write.js';
export { metricOutboxDirectory, writeCallerReceipts } from './hosted-metric-outbox-write.js';

const lifecycle: Record<string, 'start' | 'checkpoint' | 'sync' | 'finish'> = {
  start: 'start',
  save: 'checkpoint',
  sync: 'sync',
  finish: 'finish',
};
/** Recorded worker/run/batch cause of a no-owner incident. Codes alone name it. */
const noOwnerCodes = new Set([
  'LANDING_STALLED',
  'LANDING_DRIVER_EXHAUSTED',
  'MAC_RUNNER_NO_OWNER',
  'MAC_RUNNER_LEASE_EXPIRED',
]);
type Landing = {
  id: string;
  stall?: { missingOwner?: string; step?: string };
  state: 'landed' | 'terminal-failed' | null;
};
/** Bounded walk for hosted landing states the caller actually received. */
function landings(value: unknown, depth = 0, found: Landing[] = []): Landing[] {
  if (!value || typeof value !== 'object' || depth > 5 || found.length >= 50) return found;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 100)) landings(item, depth + 1, found);
    return found;
  }
  const record = value as Record<string, unknown>;
  const observation = record.observation as
    | { state?: unknown; stall?: { missingOwner?: string; step?: string } }
    | undefined;
  if (
    typeof record.id === 'string' &&
    typeof record.operationId === 'string' &&
    observation &&
    typeof observation.state === 'string'
  )
    found.push({
      id: record.id,
      ...(observation.stall ? { stall: observation.stall } : {}),
      state:
        observation.state === 'landed' || observation.state === 'terminal-failed' ? observation.state : null,
    });
  for (const item of Object.values(record)) landings(item, depth + 1, found);
  return found;
}
function cause(codes: string[], states: Landing[]) {
  const stall = states.find(state => state.stall?.missingOwner)?.stall;
  if (stall) return `${stall.missingOwner}${stall.step ? ` at ${stall.step}` : ''}`.slice(0, 200);
  return codes.find(code => noOwnerCodes.has(code)) ?? null;
}
/** A refusal's own code: a ForgeError's, or a server refusal's structured ConvexError code (friction
 * 0a9a5207: these were all counted as INTERNAL_ERROR). Anything else is INTERNAL_ERROR. */
function outcomeCode(error: unknown) {
  if (error instanceof ForgeError) return error.code;
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'INTERNAL_ERROR';
}
/** What this caller received: one outcome per lifecycle command and one delivery per
 * terminal submission state in the response. Pure; no IO. */
export function callerReceipts(input: {
  action: string;
  operationId: string | null;
  actor: string | null;
  at: string;
  cli?: CliProvenance;
  result?: unknown;
  error?: unknown;
}): CallerReceipt[] {
  const cli = input.cli && cliProvenanceSchema.safeParse(input.cli).data;
  const errorCodes = input.error === undefined ? metricErrorCodes(input.result) : [outcomeCode(input.error)];
  const states = input.error === undefined ? landings(input.result) : [];
  const recorded = cause(errorCodes, states);
  const receipts: unknown[] = [];
  const action = lifecycle[input.action];
  if (action && input.operationId)
    receipts.push({
      kind: 'outcome',
      actor: input.actor,
      at: input.at,
      ...(cli ? { cli } : {}),
      action,
      operationId: input.operationId,
      errorCodes: errorCodes.slice(0, 8),
      noOwner: recorded !== null,
      noOwnerCause: recorded,
    });
  for (const state of states)
    if (state.state) {
      const stalled = state.stall?.missingOwner
        ? `${state.stall.missingOwner}${state.stall.step ? ` at ${state.stall.step}` : ''}`.slice(0, 200)
        : null;
      receipts.push({
        kind: 'delivery',
        actor: input.actor,
        at: input.at,
        ...(cli ? { cli } : {}),
        action: input.action,
        operationId: input.operationId,
        entryId: state.id,
        state: state.state,
        noOwner: stalled !== null,
        noOwnerCause: stalled,
      });
    }
  return receipts.flatMap(receipt => {
    const parsed = callerReceiptSchema.safeParse(receipt);
    return parsed.success ? [parsed.data] : [];
  });
}
/** Pending receipts for this requester, bounded to one mutation's batch. */
export function takeCallerReceipts(directory: string, actor: string, withProvenance = true) {
  let names: string[];
  try {
    names = readdirSync(directory).filter(callerReceiptFile).sort();
  } catch {
    return null;
  }
  const files: string[] = [],
    receipts: CallerReceipt[] = [];
  const included = new Map<string, number>();
  for (const name of names) {
    const key = name.slice(0, name.lastIndexOf('.'));
    const previous = included.get(key);
    if (previous === undefined && receipts.length >= CALLER_RECEIPT_BATCH) break;
    const file = join(directory, name);
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(file, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        raw = undefined;
      }
      const parsed = callerReceiptSchema.safeParse(raw);
      // Receipts are linked complete, so an unreadable one is corrupt, not in flight.
      if (!parsed.success) {
        unlinkSync(file);
        continue;
      }
      if (parsed.data.actor !== null && parsed.data.actor !== actor) continue;
      files.push(file);
      if (previous === undefined) {
        included.set(key, receipts.length);
        receipts.push(parsed.data);
      } else if (Date.parse(parsed.data.at) < Date.parse(receipts[previous]!.at)) {
        // Old and new processes can both retain a replay. Keep the first observation.
        receipts[previous] = parsed.data;
      }
    } catch {
      // A concurrent flusher already removed it; a later mutation retries the rest.
    }
  }
  const payload = withProvenance ? receipts : receipts.map(({ cli: _cli, ...legacy }) => legacy);
  return receipts.length ? { payload: JSON.stringify(payload), files } : null;
}
export function clearCallerReceipts(files: string[]) {
  for (const file of files)
    try {
      unlinkSync(file);
    } catch {
      /* Another process already flushed it. */
    }
}
