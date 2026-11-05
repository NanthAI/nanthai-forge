// SPDX-License-Identifier: Apache-2.0
/** Page-scoped, bounded R2 HEAD rechecks. A transient provider failure (no HTTP
 * response, timeout, 408/429/5xx) is retried for the failing files only; an
 * integrity failure (missing object, size or checksum) is never retried. The
 * caller skips and reports an unverified page instead of aborting the window. */
export const HEAD_RETRY = Object.freeze({ attempts: 3, delaysMs: Object.freeze([1_000, 4_000]) });
export const MAX_SKIPPED_PAGES = 5;
const sleep = ms => new Promise(done => setTimeout(done, ms));
export function headFailure(pin, error, attempt) {
  const code = /^VERIFY_HEAD_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'VERIFY_HEAD_UNAVAILABLE';
  const head = error?.head ?? { statusClass: 'unknown' };
  const transient =
    code === 'VERIFY_HEAD_UNAVAILABLE' &&
    (head.statusClass === 'none' ||
      head.statusClass === 'unknown' ||
      head.statusClass === '5xx' ||
      head.httpStatus === 408 ||
      head.httpStatus === 429);
  return {
    storageId: pin.storageId,
    class: pin.class,
    code,
    attempt,
    transient,
    httpStatus: head.httpStatus ?? null,
    statusClass: head.statusClass ?? 'unknown',
    timeout: head.timeout === true,
    network: head.network ?? null,
  };
}
export async function headPins(pins, heads, options = {}) {
  const attempts = options.attempts ?? HEAD_RETRY.attempts,
    delaysMs = options.delaysMs ?? HEAD_RETRY.delaysMs,
    wait = options.sleep ?? sleep,
    concurrency = options.concurrency ?? 32,
    sizeOf = options.sizeOf ?? (pin => pin.size),
    digestOf = options.digestOf ?? (pin => pin.digest),
    history = [];
  let pending = pins,
    failures = [],
    attempt = 0;
  while (pending.length && attempt < attempts) {
    if (attempt) await wait(delaysMs[Math.min(attempt - 1, delaysMs.length - 1)] ?? 0);
    attempt++;
    failures = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
        for (let index = next++; index < pending.length; index = next++) {
          const pin = pending[index];
          try {
            for (const key of pin.keys) await heads.headR2(key, sizeOf(pin), digestOf(pin));
            pin.recheckedAt = new Date().toISOString();
          } catch (error) {
            failures.push(headFailure(pin, error, attempt));
          }
        }
      }),
    );
    history.push({ attempt, checked: pending.length, failed: failures.length });
    if (failures.some(f => !f.transient)) break;
    const failed = new Set(failures.map(f => f.storageId));
    pending = pending.filter(pin => failed.has(pin.storageId));
  }
  return { ok: failures.length === 0, attempts: attempt, failures, history };
}
