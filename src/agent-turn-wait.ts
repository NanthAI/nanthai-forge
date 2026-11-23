// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { invariant } from './errors.js';
import { readTurnLedger, turnSessionKey } from './agent-turn-work.js';

const FULL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `nforge wait ID [--budget SECONDS]`: the short resume command named by the turn-end
 * hook. It resolves this session's own recorded wait (one local read) and runs the same
 * canonical `nforge agent ROOT wait` on that original operation or run. A full operation id
 * this session did not record (a save, or work from another shell) runs
 * `nforge agent . wait {"operationIds":[ID]}`, so both forms find the same operations (ad80e037). */
export function resolveTurnWait(args: string[], session = turnSessionKey()): string[] {
  const [selector, ...flags] = args;
  invariant(
    selector && /^[0-9a-f][0-9a-f-]{7,35}$/i.test(selector),
    'BAD_ARGUMENT',
    'Use nforge wait ID [--budget SECONDS] with the id from the turn-end message, or run the receipt waitCommand.',
  );
  const matches = session
    ? readTurnLedger(session).work.filter(work => work.id.startsWith(selector.toLowerCase()))
    : [];
  if (matches.length === 0 && FULL_ID.test(selector))
    return ['agent', '.', 'wait', JSON.stringify({ operationIds: [selector.toLowerCase()] }), ...flags];
  invariant(
    session,
    'TURN_WORK_UNAVAILABLE',
    'No agent session is known in this shell. Pass the full operation id, or run the waitCommand printed by land or wait.',
  );
  invariant(
    matches.length === 1,
    matches.length ? 'BAD_ARGUMENT' : 'NOT_FOUND',
    matches.length
      ? 'Several recorded waits match; use the full id.'
      : 'This session has no unfinished Forge work with that id prefix. Pass the full operation id (nforge wait ID runs nforge agent . wait for it), or run the waitCommand printed by land or wait.',
  );
  const [work] = matches;
  return ['agent', work!.root, 'wait', JSON.stringify(work!.input), ...flags];
}
