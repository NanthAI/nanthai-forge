// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// "Bring it back" and "Leave it out" for a change taken out of main (J08), on its Needs you offer and its FYI row. The
// announcement says what happened, or why Forge refused; the card goes by itself when the notice changes.
import { useState } from 'react';
import { Key } from '../../ds';
import type { TakenActions, TakenAnswer, TakenTarget } from './taken-actions';

export function TakenKeys({
  target,
  title,
  actions,
  announce,
  quiet = false,
}: {
  target: TakenTarget;
  /** The Lane's title, for the announcement. */
  title: string | null;
  actions: TakenActions | undefined;
  announce: (text: string) => void;
  /** An FYI row: both keys are ghost and small. */
  quiet?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (!actions) return null;
  const what = title ? `“${title}”` : 'The change';
  const run = async (answer: Promise<TakenAnswer>, done: string) => {
    setBusy(true);
    setFailure(null);
    const result = await answer;
    setBusy(false);
    if (result.ok) announce(done);
    else {
      setFailure(result.reason);
      announce(result.reason);
    }
  };
  return (
    <>
      <Key
        kind={quiet ? 'ghost' : undefined}
        size="sm"
        disabled={busy}
        onClick={() =>
          void run(actions.bringBack(target), `${what} is open again as a Lane, at its saved work.`)
        }
      >
        Bring it back
      </Key>
      <Key
        kind="ghost"
        size="sm"
        disabled={busy}
        onClick={() => void run(actions.leaveOut(target.intentId), `${what} stays out of main.`)}
      >
        Leave it out
      </Key>
      {failure ? (
        <span className="why" role="status">
          {failure}
        </span>
      ) : null}
    </>
  );
}
