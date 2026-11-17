// SPDX-License-Identifier: Apache-2.0
import { Key, useFold } from '../../ds';
import type { PlaceProps } from '../screens';

export type LanesProps = PlaceProps;

/** One line of first-run help for the word "Lane" (stage B rule 4): shown until the reader closes it, then never. */
export function FirstRun() {
  const [open, close] = useFold('lanes-first-run', true);
  if (!open) return null;
  return (
    <p className="quietline lanes-first">
      <span>
        A <b>Lane</b> is one agent’s own copy of the project for one piece of work; it lands on main when its
        check passes.
      </span>
      <Key kind="ghost" size="sm" onClick={close}>
        Got it
      </Key>
    </p>
  );
}
