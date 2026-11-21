// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { ForgeError } from './errors.js';
import { shellQuote } from './shell-quote.js';
import { hostedActionError } from './hosted-action-error.js';
import type { HostedAgentJournal } from './hosted-agent-journal.js';

/** Refresh only the epoch after the first transaction refused it, keeping every other pin and the
 * operation id. Send must return a replay (including an unfinished one) before checking its epoch. */
export async function sendAuthorityPinned<R extends { authorityEpoch: number }, T>(
  journal: HostedAgentJournal,
  key: string,
  epoch: number | undefined,
  build: () => R | Promise<R>,
  send: (request: R) => Promise<T>,
): Promise<T> {
  const request = await journal.retain(key, build);
  try {
    return await send(request);
  } catch (error) {
    const refusal = hostedActionError(error, key);
    if (
      epoch === undefined ||
      request.authorityEpoch === epoch ||
      refusal.recovery ||
      !authorityCode(refusal.code)
    )
      throw error;
    return send(journal.replaceRefused(key, request, { ...request, authorityEpoch: epoch }));
  }
}

/** Tries per call when main keeps moving between the main read and the server's check. */
export const MAIN_PIN_TRIES = 3;

/** The server refused a request pinned to an observed main head (CHANNEL_CHANGED) inside the one
 * transaction that would begin its operation, so nothing began. */
export class MainPinRefused extends Error {
  constructor(readonly refusal: unknown) {
    super(refusal instanceof Error ? refusal.message : String(refusal));
  }
}

/** True for the main-pin refusal of a request whose operation never began. */
export function mainPinRefusal(error: unknown, phase: string) {
  return hostedActionError(error, phase).code === 'CHANNEL_CHANGED';
}

/** The server refused a request's source authority epoch while beginning its operation. It checks
 * the epoch only for an operation id it has not seen (beginHostedOperation), in that transaction, so
 * nothing began. The project moved to a new epoch (a source cutover) after the request was built. */
export class AuthorityPinRefused extends Error {
  constructor(readonly refusal: unknown) {
    super(refusal instanceof Error ? refusal.message : String(refusal));
  }
}

/** True for an authority-epoch refusal of a prepare (review b1448b61 N3). */
export function authorityPinRefusal(error: unknown, phase: string) {
  return authorityCode(hostedActionError(error, phase).code);
}
/** An authority-epoch refusal code, as a recorded failure carries it. */
export const authorityCode = (code: unknown) =>
  code === 'SOURCE_AUTHORITY_CHANGED' || code === 'SOURCE_AUTHORITY_STALE';

/** The refusal of the one transaction that would begin a pinned request, as the signal its sender
 * rebuilds on (nothing began): a moved main or an older authority epoch. Any other error unchanged. */
export function pinRefused(error: unknown, phase: string): unknown {
  if (mainPinRefusal(error, phase)) return new MainPinRefused(error);
  if (authorityPinRefusal(error, phase)) return new AuthorityPinRefused(error);
  return error;
}

/**
 * The N3 rule, began half (review b1448b61, Item 1d69905b). An operation that began at an older
 * source authority epoch can never finish: the server checks its pinned epoch on every later write to
 * it (stage, submit, job claims and callbacks, publication), and epochs only rise. It published
 * nothing. Its retained request is useless to a replay, so the caller names the one next command: the
 * same action under a fresh operation id. True only for an unfinished operation whose epoch this
 * command can compare; the normal path (same epoch) costs nothing.
 */
export function beganAtOlderEpoch(began: number | undefined, epoch: number, terminal: unknown) {
  return began !== undefined && began !== epoch && !terminal;
}

/** The one refusal for an operation that began at an older epoch: names the same action with a fresh
 * operation id (`next`, `command`). `subject` reads as the start of a sentence ("This sync"). */
export function olderEpochRefusal(
  root: string,
  code: string,
  subject: string,
  began: number,
  epoch: number,
  continuation: { action: string; parameters: Record<string, unknown> },
  dropped = '',
) {
  return freshOperationRefusal(
    root,
    code,
    `${subject} began at source authority epoch ${began}, and the project is now at epoch ${epoch}, so it can never finish. It published nothing${dropped}.`,
    continuation,
  );
}
/** A retained operation that can never finish under its id: the refusal names the same action as a new operation. */
export function freshOperationRefusal(
  root: string,
  code: string,
  message: string,
  continuation: { action: string; parameters: Record<string, unknown> },
) {
  const parameters = { ...continuation.parameters, operationId: randomUUID() };
  const command = `nforge agent ${shellQuote(root)} ${continuation.action} ${shellQuote(JSON.stringify(parameters))}`;
  return new ForgeError(code, `${message} Run it again as a new operation: ${command}`, undefined, {
    root,
    next: { action: continuation.action, ...parameters },
    command,
  });
}

/** Thrown by a source drive whose replayed operation began at an older epoch (beganAtOlderEpoch);
 * its caller turns it into olderEpochRefusal with its own continuation. */
export class BeganAtOlderEpoch extends ForgeError {
  constructor(
    readonly began: number,
    readonly epoch: number,
  ) {
    super(
      'SOURCE_AUTHORITY_CHANGED',
      `This operation began at source authority epoch ${began}, and the project is now at epoch ${epoch}, so it can never finish. Run it again as a new operation.`,
    );
  }
}

/**
 * Start, sync and compose retain their request per operation so a replay sends the exact same
 * bytes. Those requests pin the main head observed when they were built. The server checks that
 * pin only after it finds no begun operation for the id, in the same transaction, so a
 * MainPinRefused means the retained request can never succeed and nothing began: drop it and
 * rebuild on the current main under the same operation (friction b8c0a4f6: eight replays of one
 * land --save returned CHANNEL_CHANGED because the retained compose request kept the old head).
 * `build` reads main again; `send` throws MainPinRefused only for a refusal that began nothing.
 * A request pinned by the caller (an explicit target) is never rebuilt: `rebuild` is false.
 *
 * The same holds for the source authority epoch (`authority`: this command's epoch and the one a
 * request pins). The server checks it only when beginning a new operation id (beginHostedOperation),
 * so an AuthorityPinRefused began nothing: the N3 rule's other half, rebuild under the same id. The
 * epoch is never a caller pin, so this rebuild ignores `rebuild`.
 */
export async function sendMainPinned<R, T>(
  journal: HostedAgentJournal,
  key: string,
  build: () => Promise<R>,
  send: (request: R) => Promise<T>,
  rebuild = true,
  authority?: { epoch: number; of: (request: R) => number },
): Promise<T> {
  for (let tries = 1; ; tries++) {
    const request = await journal.retain(key, build);
    try {
      return await send(request);
    } catch (error) {
      if (error instanceof AuthorityPinRefused && authority) {
        // Stale for good either way. Refused at this command's own epoch: the epoch moved after this
        // command discovered it, and a replay rediscovers it and rebuilds.
        journal.forget(key, request);
        if (authority.of(request) === authority.epoch) throw error.refusal;
        continue;
      }
      if (!(error instanceof MainPinRefused)) throw error;
      // Stale for good: a replay of this operation must rebuild, never resend it.
      journal.forget(key, request);
      if (!rebuild) throw error.refusal;
      if (tries >= MAIN_PIN_TRIES)
        throw new ForgeError(
          'CHANNEL_CHANGED',
          `Main moved during each of ${tries} tries to send this request on its current head. Nothing began, and the stale request was dropped: a replay of this same operation builds on the new main.`,
        );
    }
  }
}
