// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ForgeError, invariant } from './errors.js';
import { digest } from './hash.js';
import { readSource } from './files.js';
import type { WorkStore } from './work-store.js';
const integer = z.number().safe().nonnegative();
const batchSchema = z.object({
  fromSequence: integer,
  throughSequence: integer,
  firstRevision: integer,
  lastRevision: integer,
  firstPendingAt: z.iso.datetime(),
  lastPendingAt: z.iso.datetime(),
});
const queueSchema = z.object({
  schema: z.literal(1),
  ownerId: z.uuid(),
  sequence: integer,
  capturedThrough: integer,
  capturedAt: z.iso.datetime().optional(),
  captureWorkPointerSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  pending: z.array(batchSchema),
});
export type PendingExchange = z.infer<typeof queueSchema>;
/** Local coverage of saved mutations, not a claim that missing evidence was backed up. */
export const pendingExchangeCaptureSchema = z.object({
  schema: z.literal(1),
  ownerId: z.uuid(),
  throughSequence: integer,
  capturedAt: z.iso.datetime(),
  workRevision: integer,
  workSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type PendingExchangeCapture = z.infer<typeof pendingExchangeCaptureSchema>;
const bookkeeping = new AsyncLocalStorage<boolean>();
/** Reconciliation imports already-hosted mutations and records its own receipt. */
export const exchangeBookkeeping = <T>(run: () => T): T => bookkeeping.run(true, run);
const filename = 'pending-exchange.json';
export function readPendingExchange(directory: string): PendingExchange | undefined {
  const path = join(directory, filename);
  if (!existsSync(path)) return undefined;
  try {
    return queueSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    throw new ForgeError(
      'INVALID_PENDING_EXCHANGE',
      'Pending exchange metadata is invalid. Existing saved Work remains preserved.',
    );
  }
}
function fresh(): PendingExchange {
  return { schema: 1, ownerId: randomUUID(), sequence: 0, capturedThrough: 0, pending: [] };
}
function prepareSave(directory: string, state: PendingExchange) {
  const path = join(directory, filename),
    temporary = `${path}.${randomUUID()}.tmp`;
  const bytes = Buffer.from(JSON.stringify(queueSchema.parse(state)) + '\n');
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return () => {
      try {
        const staged = readSource(directory, temporary.slice(directory.length + 1), Number.MAX_SAFE_INTEGER);
        invariant(
          staged && staged.equals(bytes),
          'INVALID_PENDING_EXCHANGE',
          'Prepared pending exchange bytes changed; committed Work is preserved.',
        );
        renameSync(temporary, path);
        const parent = openSync(directory, 'r');
        try {
          fsyncSync(parent);
        } finally {
          closeSync(parent);
        }
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    };
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}
function save(directory: string, state: PendingExchange) {
  prepareSave(directory, state)();
}
/** Stage before writer admission; publication checks the captured queue under
 * the owner lock BEFORE Work. A crash can over-report, but never omit a save. */
export function preparePendingExchange(directory: string, revision: number, at = new Date().toISOString()) {
  if (bookkeeping.getStore()) return () => {};
  const path = join(directory, filename);
  const before = existsSync(path) ? readFileSync(path) : undefined;
  let state: PendingExchange;
  try {
    state = before ? queueSchema.parse(JSON.parse(before.toString('utf8'))) : fresh();
  } catch {
    throw new ForgeError(
      'INVALID_PENDING_EXCHANGE',
      'Pending exchange metadata is invalid. Existing saved Work remains preserved.',
    );
  }
  const sequence = ++state.sequence,
    tail = state.pending.at(-1);
  if (tail && tail.throughSequence > state.capturedThrough) {
    tail.throughSequence = sequence;
    tail.lastRevision = revision;
    tail.lastPendingAt = at;
  } else
    state.pending.push({
      fromSequence: sequence,
      throughSequence: sequence,
      firstRevision: revision,
      lastRevision: revision,
      firstPendingAt: at,
      lastPendingAt: at,
    });
  const publish = prepareSave(directory, state);
  return () => {
    const current = existsSync(path) ? readFileSync(path) : undefined;
    invariant(
      before ? !!current && before.equals(current) : current === undefined,
      'WORK_STALE',
      'Pending exchange changed during preparation; retry without overwriting its capture.',
    );
    publish();
  };
}
export function recordPendingExchange(directory: string, revision: number, at = new Date().toISOString()) {
  preparePendingExchange(directory, revision, at)();
}
/** Seal the current burst under the SAME owner lock that pins the Work pointer.
 * Future writes start a new batch, retaining their own earliest pending time.
 * A Git exporter may seal before its snapshot; intervening saves conservatively stay pending. */
export function capturePendingExchange(directory: string, pointer: Buffer | null) {
  const state = readPendingExchange(directory) ?? fresh();
  const pointerSha256 = digest(pointer ?? Buffer.alloc(0));
  if (
    state.capturedThrough !== state.sequence ||
    !state.capturedAt ||
    state.captureWorkPointerSha256 !== pointerSha256
  ) {
    state.capturedThrough = state.sequence;
    state.capturedAt = new Date().toISOString();
    state.captureWorkPointerSha256 = pointerSha256;
    save(directory, state);
  }
  return {
    schema: 1 as const,
    ownerId: state.ownerId,
    throughSequence: state.sequence,
    capturedAt: state.capturedAt!,
  };
}
/** Call only after a successful full publication/source return with complete
 * evidence. Replays and older captures never clear a newer pending batch. */
export type PendingExchangeCoverage = {
  capture: PendingExchangeCapture;
  completeHistory: boolean;
  unavailable: string[];
};
export function acknowledgePendingExchange(store: WorkStore, coverage: PendingExchangeCoverage) {
  if (!coverage.completeHistory || coverage.unavailable.length) return;
  const capture = pendingExchangeCaptureSchema.parse(coverage.capture);
  return store.locked(
    () => {
      const state = readPendingExchange(store.directory);
      if (!state || state.ownerId !== capture.ownerId) return;
      invariant(
        capture.throughSequence <= state.capturedThrough,
        'WORK_OPERATION_CHANGED',
        'Exchange coverage is newer than the retained local capture.',
      );
      const pending = state.pending.filter(batch => batch.throughSequence > capture.throughSequence);
      if (pending.length === state.pending.length) return;
      state.pending = pending;
      save(store.directory, state);
    },
    { operation: 'record exchange coverage' },
  );
}
