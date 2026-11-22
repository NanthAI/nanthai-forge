// SPDX-License-Identifier: Apache-2.0
import { useLayoutEffect, useRef, useState } from 'react';
import { useMutation } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import { Key, State } from '../ds';
import { A } from './frames';

export type SaveFailure = NonNullable<FunctionReturnType<typeof api.projectHostedLanes.head>['saveFailure']>;

export function SaveFailureNotice({
  projectId,
  laneId,
  failure,
  lane,
}: {
  projectId: Id<'hostedProjects'>;
  laneId: string;
  failure: SaveFailure;
  lane?: { href: string; label: string };
}) {
  const dismiss = useMutation(api.projectHostedSaves.dismissFailure);
  const notice = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  const [status, setStatus] = useState<'ready' | 'dismissing' | 'error'>('ready');

  useLayoutEffect(() => {
    const element = notice.current;
    return () => {
      if (element?.contains(document.activeElement)) element.closest('main')?.focus({ preventScroll: true });
    };
  }, []);

  async function press() {
    if (pending.current) return;
    pending.current = true;
    setStatus('dismissing');
    try {
      const { operationId, attemptId } = failure;
      // The live read removes the notice when the exact failure clears.
      if (await dismiss({ projectId, laneId, operationId, attemptId })) return;
    } catch {
      // Leave the failure visible if the request did not clear it.
    }
    pending.current = false;
    setStatus('error');
  }

  return (
    <div className="notice" data-st="failed" ref={notice}>
      <p className="any" role="status">
        <State word="Save failed" />{' '}
        {lane ? (
          <>
            <A className="lk" href={lane.href} dir="auto">
              {lane.label}
            </A>{' '}
          </>
        ) : null}
        <code className="mono">{failure.code}</code>
      </p>
      <Key
        kind="ghost"
        size="sm"
        aria-label={lane ? `Dismiss save failure for ${lane.label}` : 'Dismiss save failure'}
        aria-disabled={status === 'dismissing'}
        onClick={() => void press()}
      >
        {status === 'dismissing' ? 'Dismissing…' : 'Dismiss'}
      </Key>
      {status === 'error' ? <p role="alert">Could not dismiss this save failure.</p> : null}
    </div>
  );
}
