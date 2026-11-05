// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import { readTurnLedger, turnSessionKey } from './agent-turn-work.js';

/** `nforge wait ID [--budget SECONDS]`: the short resume command named by the turn-end
 * hook. It resolves this session's own recorded wait (one local read) and runs the same
 * canonical `nforge agent ROOT wait` on that original operation or run. */
export function resolveTurnWait(args: string[], session = turnSessionKey()): string[] {
  const [selector, ...flags] = args;
  invariant(
    selector && /^[0-9a-f][0-9a-f-]{7,35}$/i.test(selector),
    'BAD_ARGUMENT',
    'Use nforge wait ID [--budget SECONDS] with the id from the turn-end message, or run the receipt waitCommand.',
  );
  invariant(
    session,
    'TURN_WORK_UNAVAILABLE',
    'No agent session is known in this shell. Run the waitCommand printed by land or wait.',
  );
  const matches = readTurnLedger(session).work.filter(work => work.id.startsWith(selector.toLowerCase()));
  invariant(
    matches.length === 1,
    matches.length ? 'BAD_ARGUMENT' : 'NOT_FOUND',
    matches.length
      ? 'Several recorded waits match; use the full id.'
      : 'This session has no unfinished Forge work with that id. Run the waitCommand printed by land or wait.',
  );
  const [work] = matches;
  return ['agent', work!.root, 'wait', JSON.stringify(work!.input), ...flags];
}
