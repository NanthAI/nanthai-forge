// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// What a cell's result.json counts as (Item 368ac54f, guard 5). A cell stopped from outside (a
// runner limit: the background command's timeout, a signal, or a process gone without a result)
// is void-infrastructure: the bench failed to run it, the product did not crash it. It is rerun
// once, automatically; a second infrastructure stop in a row is reported, not looped.

export const VOID_INFRASTRUCTURE = 'void-infrastructure';
export const infrastructureVoid = cause => `${VOID_INFRASTRUCTURE}: ${cause}`;

/** The fields a cell stopped by `signal` records instead of `crashed`. */
export const signalVoid = signal => ({
  interrupted: signal,
  voidKind: VOID_INFRASTRUCTURE,
  voided: [infrastructureVoid(`killed by ${signal} (runner limit or operator stop)`)],
});

/** A cell process that is gone without writing result.json (SIGKILL, machine sleep, OOM). */
export const orphanResult = ({ cellId, key }) => ({
  cellId,
  key,
  interrupted: true,
  voidKind: VOID_INFRASTRUCTURE,
  voided: [infrastructureVoid('process gone without a result (runner limit)')],
});

/** refused | void-infrastructure | crashed | void | complete (missing: no result). */
export function cellOutcome(result) {
  if (!result) return 'missing';
  if (result.refused) return 'refused';
  if (result.voidKind === VOID_INFRASTRUCTURE) return VOID_INFRASTRUCTURE;
  if (result.crashed) return 'crashed';
  if (result.voided?.length) return 'void';
  return 'complete';
}

/** Attempts of one cell command, oldest first. Rerun once when the last one is
 * void-infrastructure and was not itself the rerun of an infrastructure stop. */
export function rerunDecision(attempts) {
  const last = attempts.at(-1);
  if (cellOutcome(last) !== VOID_INFRASTRUCTURE) return { rerun: false };
  if (cellOutcome(attempts.at(-2)) === VOID_INFRASTRUCTURE)
    return {
      rerun: false,
      reason: `two infrastructure stops in a row (${attempts
        .slice(-2)
        .map(a => a.cellId)
        .join(', ')}): the automatic rerun is spent; raise the runner limit or ask the lead`,
    };
  return { rerun: true, rerunOf: last.cellId ?? null };
}
