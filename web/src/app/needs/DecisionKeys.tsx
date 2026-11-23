// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Approve and land / Decline for one held landing (Item 48049998): the same two keys on Needs me and the Lane page,
// through decide.ts. The announcement says what happened, or the server's own words when it refused.
import { useId, useState } from 'react';
import { Key } from '../../ds';
import type { Decide, DecideTarget } from './decide';
import { githubContinue } from '../../review/github-continue';

/** The most a decline reason can say; the server trims to the same (projectHostedOwnerReview:decline). */
export const DECLINE_REASON_MAX = 500;

/** Decline with an optional typed reason (Item 0a99ab23; the old /approve page asked for one). The key opens a small
 * form in place; an empty reason is a plain decline, and the agent is sent the reason when there is one. */
function DeclineKey({ disabled, onDecline }: { disabled: boolean; onDecline: (reason: string) => void }) {
  const [open, setOpen] = useState(false),
    [why, setWhy] = useState(''),
    count = useId();
  if (!open)
    return (
      <Key disabled={disabled} onClick={() => setOpen(true)}>
        Decline
      </Key>
    );
  return (
    <form
      className="decline-why"
      onSubmit={event => {
        event.preventDefault();
        onDecline(why);
      }}
      onKeyDown={event => {
        if (event.key === 'Escape' && !disabled) setOpen(false);
      }}
    >
      <label className="f">
        <span>
          Why <span className="faint">(optional, sent to the agent)</span>
        </span>
        <textarea
          className="inp"
          rows={3}
          autoFocus
          maxLength={DECLINE_REASON_MAX}
          aria-describedby={count}
          value={why}
          disabled={disabled}
          onChange={event => setWhy(event.target.value)}
        />
      </label>
      <span id={count} className="decline-count">
        {why.length}/{DECLINE_REASON_MAX}
      </span>
      <div className="decline-keys">
        <Key type="submit" disabled={disabled}>
          Decline
        </Key>
        <Key kind="ghost" disabled={disabled} onClick={() => setOpen(false)}>
          Not now
        </Key>
      </div>
    </form>
  );
}

export function useDecideRun(decide: Decide, announce: (text: string) => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (
    laneId: string | null,
    target: DecideTarget,
    decision: 'grant' | 'decline',
    done: string,
    reason?: string,
  ) => {
    const why = reason?.trim();
    const extra = why ? { reason: why } : {};
    const input =
      'landing' in target
        ? { ...target, ...(laneId ? { laneId } : {}), decision, ...extra }
        : laneId
          ? { ...target, laneId, decision, ...extra }
          : null;
    if (!input) return;
    setBusy(decision);
    try {
      const reply = await decide(input);
      const failed = /"error"\s*:/.test(reply)
        ? (JSON.parse(reply).error?.message as string | undefined)
        : undefined;
      announce(failed ? `Not done: ${failed}` : done);
      // Item c63c2171: an allowed GitHub connect goes on to GitHub's authorization.
      const github = failed ? null : githubContinue(JSON.parse(reply));
      if (github) location.assign(github);
    } catch {
      announce('Not done: Forge could not be reached. Nothing changed; try again.');
    } finally {
      setBusy(null);
    }
  };
  return { run, busy };
}

/** Approve or Decline for a request asked ahead (it holds nothing yet): Needs me's Asked ahead rows and the Lane page
 * (Item 0a99ab23). `head` is the one the mutation checks: the request's own for a setting or fork run, the Lane's
 * current save on the Lane page. A declined request the owner may still approve shows Approve alone. A GitHub connect
 * goes on to GitHub's authorization once allowed. */
export function AheadKeys({
  row,
  declined = false,
  decide,
  announce,
}: {
  row: { laneId: string; head: string; setting?: { origin: string } };
  declined?: boolean;
  decide: Decide;
  announce: (text: string) => void;
}) {
  const { run, busy } = useDecideRun(decide, announce);
  const connect = row.setting?.origin === 'github-connect';
  return (
    <>
      <Key
        disabled={busy !== null}
        onClick={() =>
          run(
            row.laneId,
            { head: row.head },
            'grant',
            connect ? 'Allowed. Opening GitHub to authorize.' : 'Approved. It is in the log.',
          )
        }
      >
        {connect ? 'Allow on GitHub' : 'Approve'}
      </Key>
      {declined ? null : (
        <DeclineKey
          disabled={busy !== null}
          onDecline={reason =>
            run(row.laneId, { head: row.head }, 'decline', 'Declined. The agent was told.', reason)
          }
        />
      )}
    </>
  );
}

/** No "No check ran" fact line here (Item e6f1290b): the Needs me and Lane-page row (projectNeedsMe:read) carries no
 * check data, and saying nothing is better than guessing or adding a read. The Review page and a held landing's own
 * page say it from their own landing read (lane/landing-model.ts NO_CHECK_FACT). */
export function DecisionKeys({
  laneId,
  target,
  decide,
  announce,
}: {
  laneId: string | null;
  target: DecideTarget;
  decide: Decide;
  announce: (text: string) => void;
}) {
  const { run, busy } = useDecideRun(decide, announce);
  return (
    <>
      <Key
        kind="rec"
        keys="a"
        disabled={busy !== null}
        onClick={() =>
          run(laneId, target, 'grant', 'Approved. It lands now; main is checked again on top of it.')
        }
      >
        Approve and land
      </Key>
      <DeclineKey
        disabled={busy !== null}
        onDecline={reason =>
          run(laneId, target, 'decline', 'Declined. The agent was told and keeps its saves.', reason)
        }
      />
    </>
  );
}
