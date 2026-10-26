// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import type { WorkStore } from './work-store.js';

/** Resolve the existing check for a full audit, without changing acceptance
 * metadata or introducing a passing-check publication policy. */
export function requestPushAudit(store: WorkStore) {
  const data = store.load();
  const main = data.channelMoves.filter(move => move.channel === 'main' && move.status === 'accepted').at(-1);
  if (!main) return;
  const selected = main.postAccept && data.checks.find(check => check.id === main.postAccept!.checkId);
  const named = data.checks.filter(check => check.name.trim().toLowerCase() === 'verify');
  const check =
    selected || (named.length === 1 ? named[0] : data.checks.length === 1 ? data.checks[0] : undefined);
  invariant(
    check,
    'CHECK_REQUIRED',
    'Define a verify check (or a single check) to audit accepted main before GitHub push.',
  );
  return { channel: 'main', checkId: check.id };
}
