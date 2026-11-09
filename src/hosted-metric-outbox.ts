// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ForgeError } from './errors.js';
import { metricErrorCodes } from './self-metrics-journal.js';
import { CALLER_RECEIPT_BATCH, callerReceiptSchema, type CallerReceipt } from './self-metric-receipts.js';
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
/** What this caller received: one outcome per lifecycle command and one delivery per
 * terminal submission state in the response. Pure; no IO. */
export function callerReceipts(input: {
  action: string;
  operationId: string | null;
  actor: string | null;
  at: string;
  result?: unknown;
  error?: unknown;
}): CallerReceipt[] {
  const errorCodes =
    input.error === undefined
      ? metricErrorCodes(input.result)
      : [input.error instanceof ForgeError ? input.error.code : 'INTERNAL_ERROR'];
  const states = input.error === undefined ? landings(input.result) : [];
  const recorded = cause(errorCodes, states);
  const receipts: unknown[] = [];
  const action = lifecycle[input.action];
  if (action && input.operationId)
    receipts.push({
      kind: 'outcome',
      actor: input.actor,
      at: input.at,
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
/** Oldest pending receipts for this requester, bounded to one mutation's batch. */
export function takeCallerReceipts(directory: string, actor: string) {
  let names: string[];
  try {
    names = readdirSync(directory)
      .filter(name => name.endsWith('.json'))
      .sort();
  } catch {
    return null;
  }
  const files: string[] = [],
    receipts: CallerReceipt[] = [];
  for (const name of names) {
    if (receipts.length >= CALLER_RECEIPT_BATCH) break;
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
      receipts.push(parsed.data);
    } catch {
      // A concurrent flusher already removed it; a later mutation retries the rest.
    }
  }
  return receipts.length ? { payload: JSON.stringify(receipts), files } : null;
}
export function clearCallerReceipts(files: string[]) {
  for (const file of files)
    try {
      unlinkSync(file);
    } catch {
      /* Another process already flushed it. */
    }
}
