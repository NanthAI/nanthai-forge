// SPDX-License-Identifier: Apache-2.0
import { useRef, useState } from 'react';
import { Button, ButtonLink } from '../ui/primitives';
import { Glyph } from '../ui/Glyph';
import { hostedHref } from './hosted-links';
import type { useFixAnswers } from './fix-answers';

export type FixNoticeActions = Partial<Pick<ReturnType<typeof useFixAnswers>, 'startFix' | 'closeFix'>>;
const startTitle =
  'Opens a sibling Lane from the reverted head with the failing tests, the diff and the undo command in its brief. Finishing it lands the original change plus the fix through the full check.';

/** Recovery actions use the existing viewer authority; Close has the approved inline confirmation. */
export function FixNoticeAnswers({
  intentId,
  ack,
  laneHref,
  canStart,
  owner,
}: {
  intentId: string;
  ack: FixNoticeActions;
  laneHref: (laneId: string) => string;
  canStart: boolean;
  owner: boolean;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<'start' | 'close' | null>(null);
  const pending = useRef(false);
  const start = async () => {
    if (pending.current || !ack.startFix) return;
    pending.current = true;
    setBusy('start');
    try {
      const laneId = await ack.startFix(intentId);
      if (laneId) window.location.assign(laneHref(laneId));
    } finally {
      pending.current = false;
      setBusy(null);
    }
  };
  const close = async () => {
    if (pending.current || !ack.closeFix) return;
    pending.current = true;
    setBusy('close');
    try {
      if (await ack.closeFix(intentId)) setConfirm(false);
    } finally {
      pending.current = false;
      setBusy(null);
    }
  };
  if (confirm && owner)
    return (
      <div className="fx-dec-confirm">
        <b>Close without a fix?</b>
        <span className="fx-muted">The Intent is marked abandoned; its Lane and saved head stay.</span>
        <Button size="sm" variant="rec" disabled={busy !== null} onClick={() => void close()}>
          Close Intent
        </Button>
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirm(false)}>
          Keep
        </Button>
      </div>
    );
  return (
    <div className="fx-answers">
      {canStart && ack.startFix && (
        <Button
          size="sm"
          variant="rec"
          title={startTitle}
          disabled={busy !== null}
          onClick={() => void start()}
        >
          {busy !== 'start' && <Glyph name="wrench" size={12} />}
          {busy === 'start' ? 'Starting…' : 'Start a fix'}
        </Button>
      )}
      <ButtonLink size="sm" href={hostedHref({ projectTab: 'intent', intent: intentId })}>
        Open Intent
      </ButtonLink>
      {owner && ack.closeFix && busy !== 'start' && (
        <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
          Close
        </Button>
      )}
    </div>
  );
}
