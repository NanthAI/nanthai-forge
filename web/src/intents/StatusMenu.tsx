// SPDX-License-Identifier: Apache-2.0
import { Menu } from '../ui/Menu';
import { Glyph } from '../ui/Glyph';
import { Button, StatusPill } from '../ui/primitives';
import type { Tone } from '../ui/status';

export type IntentAction = 'propose' | 'plan' | 'complete' | 'abandon' | 'reopen';
export function StatusMenu({
  label,
  tone,
  closed,
  proposed,
  planned,
  busy,
  onAction,
  abandon,
  canPropose,
}: {
  label: string;
  tone: Tone;
  closed: boolean;
  proposed?: boolean;
  planned?: boolean;
  busy?: boolean;
  onAction: (action: IntentAction) => void;
  abandon?: boolean;
  canPropose?: boolean;
}) {
  return (
    <Menu
      ariaLabel="Intent status"
      className="fx-intent-status"
      label={
        <StatusPill tone={tone}>
          {label}
          <Glyph name="down" size={10} />
        </StatusPill>
      }
    >
      {closed ? (
        <Button disabled={busy} onClick={() => onAction('reopen')}>
          Reopen
        </Button>
      ) : (
        <>
          {proposed ? (
            <Button disabled={busy} onClick={() => onAction('plan')}>
              Plan it
            </Button>
          ) : (
            <>
              <Button disabled={busy || !canPropose} onClick={() => onAction('propose')}>
                Proposed
              </Button>
              <Button
                className={planned ? 'fx-intent-current' : undefined}
                disabled={busy || !planned}
                onClick={() => onAction('plan')}
              >
                <Glyph name="plain" size={12} />
                Planned
              </Button>
            </>
          )}
          <Button disabled title="starts with the first Lane">
            <Glyph name="active" size={12} />
            In motion
          </Button>
          <Button disabled={busy} onClick={() => onAction('complete')}>
            <Glyph name="passed" size={12} />
            Mark done
          </Button>
          <hr className="fx-intent-status-separator" />
          <Button
            disabled={busy || !abandon}
            title={!abandon ? 'No hosted abandonment action for this planning record' : undefined}
            onClick={() => onAction('abandon')}
          >
            {proposed ? 'Decline…' : 'Abandon…'}
          </Button>
        </>
      )}
    </Menu>
  );
}
