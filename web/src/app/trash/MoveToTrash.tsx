// SPDX-License-Identifier: Apache-2.0
// Move to trash: always a sheet (SPEC-01-trash, "Screens" 2). Restore does not bring back other people's access, so an
// Undo would not undo; the sheet names what is lost. It reads nothing: the Lane count comes from the row on screen.
import { useState } from 'react';
import { Key, Sheet } from '../../ds';
import './trash.css';
import { hostedError } from '../../snapshot';
import { untilDay } from './trash-model';

export function MoveToTrash({
  name,
  lanes,
  now,
  move,
  close,
}: {
  name: string;
  /** Open Lanes on the row, or null when the screen does not know. */
  lanes: { n: number; atLeast: boolean } | null;
  now: number;
  move: () => Promise<void>;
  close: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const until = untilDay(now);
  const laneWords = !lanes
    ? ''
    : lanes.n === 0
      ? 'It has no open Lanes.'
      : `Its ${lanes.atLeast ? 'at least ' : ''}${lanes.n.toLocaleString('en')} open ${lanes.n === 1 && !lanes.atLeast ? 'Lane stops where it is' : 'Lanes stop where they are'}; every save is kept.`;
  const go = async () => {
    setPending(true);
    setError('');
    try {
      await move();
    } catch (failure) {
      setError(hostedError(failure));
      setPending(false);
    }
  };
  return (
    <Sheet
      open
      title="Move to trash"
      onOpenChange={open => {
        if (!open && !pending) close();
      }}
      footer={
        <>
          <Key disabled={pending} onClick={() => void go()}>
            {pending ? 'Moving…' : 'Move to trash'}
          </Key>
          <Key kind="ghost" keys="Esc" disabled={pending} onClick={close} autoFocus>
            Keep it
          </Key>
        </>
      }
    >
      <div className="trash-sheet">
        <h3 dir="auto">Move {name} to the trash?</h3>
        <p>
          <strong>Everyone loses access now, you included.</strong> {laneWords}
        </p>
        <dl className="keeps">
          <div>
            <dt>Comes back</dt>
            <dd>The source, every Lane and landing, Items and settings, when you restore it.</dd>
          </div>
          <div>
            <dt>Does not</dt>
            <dd>
              Other people's access, invitations, runners and tokens. You invite and register them again.
            </dd>
          </div>
          <div>
            <dt>Until</dt>
            <dd>{until}. After 90 days in the trash it is deleted for good.</dd>
          </div>
        </dl>
        {error ? (
          <p className="pf" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
