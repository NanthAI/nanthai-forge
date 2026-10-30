// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { Button, ButtonLink } from '../ui/primitives';
import type { DecisionItem } from './attention';

export type OverlapActions = {
  acknowledgeOverlaps?: (laneId: string, noticeIds: string[]) => Promise<boolean>;
};
export function OverlapAnswers({
  item,
  ack,
  laneHref,
  notNow,
}: {
  item: DecisionItem;
  ack: OverlapActions;
  laneHref: (id: string) => string;
  notNow: () => void;
}) {
  const [state, setState] = useState<'ready' | 'busy' | 'done' | 'failed'>('ready');
  const count = item.overlapCount ?? item.noticeIds?.length ?? 0;
  return (
    <>
      {state === 'done' ? (
        <span className="fx-done">Acknowledged as you.</span>
      ) : (
        ack.acknowledgeOverlaps && (
          <Button
            size="sm"
            variant="rec"
            disabled={state === 'busy'}
            title="Records the answer for this Lane as you. The agent's next edit of this file goes ahead; whichever Lane is accepted second still updates from main first."
            onClick={async () => {
              setState('busy');
              setState((await ack.acknowledgeOverlaps!(item.laneId!, item.noticeIds!)) ? 'done' : 'failed');
            }}
          >
            {state === 'failed'
              ? 'Retry: Acknowledge'
              : count >= 2
                ? `Acknowledge all (${count})`
                : 'Acknowledge'}
          </Button>
        )
      )}
      <ButtonLink size="sm" href={laneHref(item.laneId!)}>
        Open Lane
      </ButtonLink>
      {state !== 'done' && (
        <Button size="sm" variant="ghost" onClick={notNow}>
          Not now
        </Button>
      )}
    </>
  );
}
