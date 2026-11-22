// SPDX-License-Identifier: Apache-2.0
// Approve and land / Decline for one held landing (Item 48049998): the same two keys on Needs me and the Lane page,
// through decide.ts. The announcement says what happened, or the server's own words when it refused.
import { useState } from 'react';
import { Key } from '../../ds';
import type { Decide, DecideTarget } from './decide';
import { githubContinue } from '../../review/github-continue';

export function useDecideRun(decide: Decide, announce: (text: string) => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (
    laneId: string | null,
    target: DecideTarget,
    decision: 'grant' | 'decline',
    done: string,
  ) => {
    const input =
      'landing' in target
        ? { ...target, ...(laneId ? { laneId } : {}), decision }
        : laneId
          ? { ...target, laneId, decision }
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
        <Key
          disabled={busy !== null}
          onClick={() => run(row.laneId, { head: row.head }, 'decline', 'Declined. The agent was told.')}
        >
          Decline
        </Key>
      )}
    </>
  );
}

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
      <Key
        disabled={busy !== null}
        onClick={() => run(laneId, target, 'decline', 'Declined. The agent was told and keeps its saves.')}
      >
        Decline
      </Key>
    </>
  );
}
