// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { ForgeError, withLocalFailure } from './errors.js';
import { hostedFailureCauseOf, hostedFailureDetail, transientFailureCause } from './hosted-action-error.js';
import { hostedRecoveryCommand } from './hosted-agent-resolution.js';

/** Actions that replay their retained operation once inside the same command when it fails for a
 * transient cause (Item 3f76a3df): a save that completed answers with its receipt, not a failure. A
 * preflight replays only after a hosted read failed or its dependencies were just relinked: its local
 * test run is never repeated for a server blip. */
const replayed = new Set(['save', 'checkpoint', 'tests', 'confirm-tests', 'preflight']);
export const RECONCILE_ATTEMPTS = 2;
/** Pause before the one in-command replay, so a save that is still settling has moved on; fixtures set 0. */
export const replayTiming = { delayMs: 750 };
const serverSide = (cause: string) => cause.startsWith('server-') || cause === 'connection';

/** The cause of a dispatch failure this module built, or undefined for any other error. */
export const replyCause = (error: unknown) =>
  error instanceof ForgeError &&
  error.code === 'HOSTED_ACTION_FAILED' &&
  typeof error.recovery?.cause === 'string'
    ? error.recovery.cause
    : undefined;

/** Whether a failed attempt of `action` is replayed once more inside this command. */
export function replayInside(action: string, error: unknown, attempt: number, relinked: boolean) {
  const cause = replyCause(error);
  if (!cause || attempt >= RECONCILE_ATTEMPTS || !replayed.has(action)) return undefined;
  if ((error as ForgeError).recovery?.retryable !== true) return undefined;
  if (action === 'preflight' && !serverSide(cause) && !(relinked && cause.startsWith('local-')))
    return undefined;
  return cause;
}

/** The final HOSTED_ACTION_FAILED a hosted agent command reports: its cause word, whether the same
 * command can succeed, and one next command that resumes the same retained operation. */
export function hostedFailureReply(options: {
  root: string;
  action: string;
  safe: ForgeError;
  error: unknown;
  operationId: string | null;
  /** The operation has a retained client journal entry (otherwise nothing of it was recorded). */
  retained: boolean;
  input: Record<string, unknown>;
}) {
  const { root, action, safe, error, operationId, retained, input } = options;
  const cause = hostedFailureCauseOf(safe.message) ?? 'server-exception';
  const retryable = transientFailureCause(cause);
  // A retained operation resumes through wait, which replays it and blocks on its outcome. Anything
  // else (preflight, a read, a request that failed before it was recorded) is the same command again,
  // under the same operation id when it had one; preflight keeps the static results it passed.
  const command =
    retained && operationId && action !== 'preflight'
      ? hostedRecoveryCommand(root, 'wait', { operationIds: [operationId] })
      : hostedRecoveryCommand(root, action, {
          ...input,
          ...(operationId && action !== 'preflight' ? { operationId } : {}),
        });
  const where = cause.startsWith('local-') || cause === 'cancelled' ? 'Local step of agent' : 'Hosted agent';
  const next = !retryable
    ? 'Fix the named cause first; the same command then resumes the retained operation.'
    : 'Run next: it replays the same operation and returns its receipt (a completed save is not repeated).';
  const reply = new ForgeError(
    safe.code,
    `${where} ${action} failed${hostedFailureDetail(safe.message)}. ${next}`,
    undefined,
    { cause, retryable, command },
  );
  // A local failure's stack goes to the diagnostics log the CLI names in `diagnostics`; the reply itself
  // never carries the raw message (it can hold paths or source).
  return serverSide(cause) ? reply : withLocalFailure(reply, error);
}
