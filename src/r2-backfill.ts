// SPDX-License-Identifier: Apache-2.0
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { mapExchange } from './exchange-parallel.js';
import { durableReplace } from './native-durability.js';
import { ForgeError, invariant } from './errors.js';
import { spoolBackfill, putBackfill, sampleBackfill } from './r2-backfill-transfer.js';
import { backfillKinds, type BackfillState, type BackfillTransport } from './r2-backfill-types.js';

/** Planning rates, before free tiers: decimal GB and standard R2 Class A ($4.50/million). */
export function backfillEstimate(count: number, bytes: number) {
  const egressGB = bytes / 1e9,
    convexUSD = egressGB * 0.132,
    r2ClassAUSD = (count * 4.5) / 1e6;
  return { count, bytes, egressGB, convexUSD, r2ClassAUSD, totalUSD: convexUSD + r2ClassAUSD };
}
export async function backfillInventory(transport: BackfillTransport) {
  let count = 0,
    bytes = 0,
    enabled = true;
  let revision: number | undefined,
    changed = false;
  for (const kind of backfillKinds) {
    let cursor: string | null = null;
    while (true) {
      const page = await transport.page(kind, cursor, false);
      if (revision !== undefined && revision !== page.r2Revision) changed = true;
      revision = page.r2Revision;
      count += page.page.length;
      bytes += page.page.reduce((sum, pin) => sum + pin.size, 0);
      enabled &&= page.r2Writes;
      if (page.isDone) break;
      cursor = page.cursor;
    }
  }
  return { ...backfillEstimate(count, bytes), enabled, revision: revision ?? 0, changed };
}
export async function runR2Backfill(
  transport: BackfillTransport,
  options: {
    project: string;
    statePath: string;
    dryRun?: boolean;
    resume?: boolean;
    verify?: boolean;
    progress?: (line: string) => void;
  },
) {
  const inventory = await backfillInventory(transport),
    log = options.progress ?? (() => undefined);
  log(
    `Estimate: ${inventory.count} rows, ${inventory.bytes} bytes; Convex ${inventory.egressGB.toFixed(3)} GB × $0.132 = $${inventory.convexUSD.toFixed(4)}; R2 Class A ≈ $${inventory.r2ClassAUSD.toFixed(4)}; total ≈ $${inventory.totalUSD.toFixed(4)} (one planned PUT/row, before free tiers; retries, HEAD/GET and storage excluded).`,
  );
  if (options.dryRun) return inventory;
  if (!options.verify)
    invariant(inventory.enabled, 'R2_NOT_ENABLED', 'Enable project R2 writes before backfill.');
  const statePath = resolve(options.statePath),
    mode = options.verify ? 'verify' : 'run';
  let state: BackfillState;
  if (options.resume) {
    invariant(existsSync(statePath), 'BACKFILL_STATE_MISSING', 'Use the original state file to resume.');
    state = JSON.parse(readFileSync(statePath, 'utf8')) as BackfillState;
    invariant(
      state.schema === 1 && state.project === options.project && state.mode === mode,
      'BACKFILL_STATE_CHANGED',
      'Resume the same project and mode with its original state file.',
    );
    if (state.complete) return state;
  } else {
    invariant(
      !existsSync(statePath),
      'BACKFILL_STATE_EXISTS',
      'Resume the existing operation or select a different state file.',
    );
    state = {
      schema: 1,
      project: options.project,
      operationId: randomUUID(),
      mode,
      startedAt: Date.now(),
      kind: 0,
      cursor: null,
      count: 0,
      bytes: 0,
      samples: 0,
      failures: [],
      complete: false,
    };
  }
  if (
    options.verify &&
    (inventory.changed ||
      (state.verificationRevision !== undefined && state.verificationRevision !== inventory.revision))
  ) {
    state.kind = 0;
    state.cursor = null;
    state.count = 0;
    state.bytes = 0;
    state.samples = 0;
    state.failures = [];
    log('Backfill changed since this verification started; restarting the full pass.');
  }
  if (options.verify) state.verificationRevision = inventory.revision;
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  const spool = statePath + '.files';
  mkdirSync(spool, { recursive: true, mode: 0o700 });
  const save = () => durableReplace(statePath, JSON.stringify(state) + '\n');
  save();
  log(
    `Operation ${state.operationId}; resume with --resume and this state file. Convex copies are retained; no purge is performed.`,
  );
  let migratedThisInvocation = 0;
  for (; state.kind < backfillKinds.length;) {
    // Include our already-flipped rows when replaying a page after a lost commit reply.
    const page = await transport.page(backfillKinds[state.kind]!, state.cursor, true);
    const results = await transport.check(page.page, state.operationId, !options.verify);
    const verified = new Set(results.filter(row => row.status === 'verified').map(row => row.id));
    const failures: BackfillState['failures'] = [];
    let samples = 0;
    const failed = (id: string, error: unknown) => {
      if (!(error instanceof ForgeError)) throw error;
      failures.push({ id, code: error.code });
      log(`Row ${id}: ${error.code}; not claimed as migrated/verified.`);
    };
    if (options.verify) {
      await mapExchange(page.page, 8, async (pin, index) => {
        const result = results.find(row => row.id === pin.id);
        if (result?.status === 'skipped') return;
        try {
          invariant(
            pin.location === 'r2' && result?.status === 'verified' && result.url,
            'R2_VERIFY_FAILED',
            'A row is not verified in R2.',
          );
          if ((state.count + index) % 100 === 0) {
            await sampleBackfill(result.url, pin);
            samples++;
          }
        } catch (error) {
          failed(pin.id, error);
        }
      });
    } else {
      const missing = page.page.filter(pin => results.find(row => row.id === pin.id)?.status === 'missing');
      for (const result of results)
        if (result.status === 'failed')
          failed(
            result.id,
            new ForgeError('R2_VERIFY_FAILED', 'An existing R2 key differs from the original pins.'),
          );
      const targets = missing.length ? await transport.targets(missing) : [];
      const transfers = new Map<string, Promise<void>>();
      const uploaded = await mapExchange(targets, 8, async target => {
        const pin = target.pin;
        try {
          const file = join(
            spool,
            createHash('sha256')
              .update(JSON.stringify([pin.storageId, pin.digest]))
              .digest('hex'),
          );
          let transfer = transfers.get(file);
          if (!transfer) {
            transfer = (async () => {
              await spoolBackfill(target.url, file, pin);
              await putBackfill(target.target, file);
            })();
            transfers.set(file, transfer);
          }
          await transfer;
          return pin;
        } catch (error) {
          failed(pin.id, error);
          return null;
        }
      });
      const pins = uploaded.flatMap(pin => (pin ? [pin] : []));
      if (pins.length)
        for (const checked of await transport.check(pins, state.operationId, true)) {
          if (checked.status === 'verified') verified.add(checked.id);
          else if (checked.status !== 'skipped')
            failed(
              checked.id,
              new ForgeError('R2_VERIFY_FAILED', 'Uploaded object failed its HEAD verification.'),
            );
        }
    }
    state.failures = failures;
    if (failures.length) {
      save();
      throw new ForgeError(
        'BACKFILL_ROWS_FAILED',
        `${failures.length} rows failed. Resume the same operation after resolving the reported errors.`,
      );
    }
    migratedThisInvocation += page.page.filter(pin => pin.location !== 'r2' && verified.has(pin.id)).length;
    state.count += verified.size;
    state.bytes += page.page.filter(pin => verified.has(pin.id)).reduce((sum, pin) => sum + pin.size, 0);
    state.samples += samples;
    if (page.isDone) {
      state.kind++;
      state.cursor = null;
    } else state.cursor = page.cursor;
    save(); // Advance only after all row outcomes are known; immutable R2 keys make replay safe.
    for (const pin of page.page)
      rmSync(
        join(
          spool,
          createHash('sha256')
            .update(JSON.stringify([pin.storageId, pin.digest]))
            .digest('hex'),
        ),
        { force: true },
      );
    const elapsed = (Date.now() - state.startedAt) / 1000;
    const remaining = options.verify ? undefined : Math.max(0, inventory.count - migratedThisInvocation);
    log(
      `${state.count} rows, ${state.bytes} bytes; elapsed ${elapsed.toFixed(1)}s; ETA ${state.count && remaining !== undefined ? ((elapsed * remaining) / state.count).toFixed(1) + 's' : 'unknown'}.`,
    );
  }
  // A concurrent old pending Convex upload may have completed behind our cursor.
  const remaining = await backfillInventory(transport);
  if (
    remaining.count ||
    (options.verify && (remaining.changed || remaining.revision !== state.verificationRevision))
  ) {
    if (options.verify) {
      state.kind = 0;
      state.cursor = null;
      state.count = 0;
      state.bytes = 0;
      state.samples = 0;
      save();
    }
    throw new ForgeError(
      remaining.count ? 'BACKFILL_REMAINS' : 'BACKFILL_CHANGED',
      'Storage changed or Convex rows remain. Complete backfill, then resume verification for a full pass.',
    );
  }
  if (options.verify) {
    state.verifiedAt = new Date().toISOString();
    state.safeToPurgeAfter = new Date(Date.parse(state.verifiedAt) + 14 * 86400_000).toISOString();
    log(
      `Full verified pass: ${state.count} HEAD checks, ${state.samples} downloaded SHA-256 samples. Safe to purge after ${state.safeToPurgeAfter}; purge is a separate command.`,
    );
  }
  state.complete = true;
  save();
  return state;
}
