// SPDX-License-Identifier: Apache-2.0
// Approve and land / Decline for one held landing (Item 48049998): the same two keys on Needs me and the Lane page,
// through decide.ts. The announcement says what happened, or the server's own words when it refused.
import { useState } from 'react';
import { Key } from '../../ds';
import type { Decide, DecideTarget } from './decide';
import { githubContinue } from '../../review/github-continue';

export function useDecideRun(decide: Decide, announce: (text: string) => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (laneId: string, target: DecideTarget, decision: 'grant' | 'decline', done: string) => {
    setBusy(`${laneId}:${decision}`);
    try {
      const reply = await decide({ laneId, decision, ...target });
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

export function DecisionKeys({
  laneId,
  target,
  decide,
  announce,
}: {
  laneId: string;
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
