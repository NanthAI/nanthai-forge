// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '../ui/primitives';
import { useBriefSource, type BriefRequest } from './brief';
import { DelegateSheet, type Continues } from './DelegateSheet';

/**
 * The trigger for "Hand this to an agent". Opens the delegate sheet, which builds a ready-to-paste
 * prompt for the viewer's own coding agent; nothing is sent unless the viewer asks for an inbox copy.
 */
export function CopyPrompt({
  request,
  label = 'Copy prompt',
  variant = 'ghost',
  continues,
  context,
  initiallyOpen = false,
  onClose,
  shortcut = false,
}: {
  request: Omit<BriefRequest, 'agent'>;
  label?: string;
  /** `rec` when handing work over is the recommended answer. */
  variant?: 'ghost' | 'rec' | 'secondary';
  continues?: Continues;
  /** A line under the sheet title naming the work, e.g. status pill, Lane and Intent. */
  context?: ReactNode;
  /** Opens the sheet on first render, e.g. right after "Create & hand to an agent". */
  initiallyOpen?: boolean;
  onClose?: () => void;
  /** Lane screen shortcut: Command/Ctrl + Shift + C opens this sheet. */
  shortcut?: boolean;
}) {
  const source = useBriefSource();
  const [open, setOpen] = useState(initiallyOpen);
  useEffect(() => {
    if (!shortcut || !source) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === 'c' &&
        !event.altKey
      ) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shortcut, source]);
  if (!source) return null;
  return (
    <>
      <Button
        size="sm"
        variant={variant}
        icon={variant === 'ghost' ? 'terminal' : 'handoff'}
        aria-haspopup="dialog"
        title={shortcut ? 'Hand to an agent (⌘⇧C)' : 'Copy a prompt for your coding agent'}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      {open && (
        <DelegateSheet
          request={request}
          {...(continues ? { continues } : {})}
          {...(context ? { context } : {})}
          onClose={() => {
            setOpen(false);
            onClose?.();
          }}
        />
      )}
    </>
  );
}
