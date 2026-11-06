// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';

/** The selection itself was refused: its own message names what to fix. */
const selectionErrors = new Set(['BAD_ARGUMENT', 'NOT_FOUND']);

/** A wait whose read fails (a CLI/server contract skew, an outage past retries)
 * says nothing about the work it observes, which keeps running. Never a dead end:
 * the error names the same wait as its next command (d910db6b). Formatting only. */
export function waitFailure(error: unknown, resume: { next: Record<string, unknown>; waitCommand: string }) {
  if (!(error instanceof ForgeError) || selectionErrors.has(error.code) || error.recovery) return error;
  return new ForgeError(
    error.code,
    `${error.message} The waited work is unaffected by this failed read; once the cause is fixed, resume with: ${resume.waitCommand}`,
    error.retryAt,
    { next: resume.next, command: resume.waitCommand, waitCommand: resume.waitCommand },
  );
}
