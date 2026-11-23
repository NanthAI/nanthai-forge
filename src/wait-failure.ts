// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { ForgeError } from './errors.js';

/** The selection itself was refused: its own message names what to fix. */
const selectionErrors = new Set(['BAD_ARGUMENT', 'NOT_FOUND']);

/** A wait whose read fails (a CLI/server contract skew, an outage past retries)
 * says nothing about the work it observes, which keeps running. Never a dead end:
 * the error names the same wait as its next command (d910db6b). Formatting only. */
export function waitFailure(error: unknown, resume: { next: Record<string, unknown>; waitCommand: string }) {
  if (!(error instanceof ForgeError) || selectionErrors.has(error.code)) return error;
  // A coded outcome's recovery stands as it is (a failed save settle says what to run). Only a
  // HOSTED_ACTION_FAILED whose recovery names a cause but no continuation (Item 3f76a3df) keeps that
  // cause and gains this wait as its next command.
  const recovery = error.recovery;
  if (
    recovery &&
    (error.code !== 'HOSTED_ACTION_FAILED' ||
      ['command', 'waitCommand', 'next'].some(key => recovery[key] !== undefined))
  )
    return error;
  return new ForgeError(
    error.code,
    `${error.message} The waited work is unaffected by this failed read; once the cause is fixed, resume with: ${resume.waitCommand}`,
    error.retryAt,
    { ...recovery, next: resume.next, command: resume.waitCommand, waitCommand: resume.waitCommand },
  );
}
