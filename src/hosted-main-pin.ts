// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';
import { hostedActionError } from './hosted-action-error.js';
import type { HostedAgentJournal } from './hosted-agent-journal.js';

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

/**
 * Start, sync and compose retain their request per operation so a replay sends the exact same
 * bytes. Those requests pin the main head observed when they were built. The server checks that
 * pin only after it finds no begun operation for the id, in the same transaction, so a
 * MainPinRefused means the retained request can never succeed and nothing began: drop it and
 * rebuild on the current main under the same operation (friction b8c0a4f6: eight replays of one
 * land --save returned CHANNEL_CHANGED because the retained compose request kept the old head).
 * `build` reads main again; `send` throws MainPinRefused only for a refusal that began nothing.
 * A request pinned by the caller (an explicit target) is never rebuilt: `rebuild` is false.
 */
export async function sendMainPinned<R, T>(
  journal: HostedAgentJournal,
  key: string,
  build: () => Promise<R>,
  send: (request: R) => Promise<T>,
  rebuild = true,
): Promise<T> {
  for (let tries = 1; ; tries++) {
    const request = await journal.retain(key, build);
    try {
      return await send(request);
    } catch (error) {
      if (!(error instanceof MainPinRefused)) throw error;
      // Stale for good: a replay of this operation must rebuild, never resend it.
      journal.forget(key);
      if (!rebuild) throw error.refusal;
      if (tries >= MAIN_PIN_TRIES)
        throw new ForgeError(
          'CHANNEL_CHANGED',
          `Main moved during each of ${tries} tries to send this request on its current head. Nothing began, and the stale request was dropped: a replay of this same operation builds on the new main.`,
        );
    }
  }
}
