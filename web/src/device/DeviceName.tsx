// SPDX-License-Identifier: Apache-2.0
// The terminal-chosen device name, as both approval pages show it: cleaned and capped (shownDeviceName), quoted and
// marked as not verified. Callers place it last, after the facts the server knows, and never in a heading.
import { shownDeviceName } from './code';

export const NOT_VERIFIED = 'chosen by the terminal, not verified';

export function UntrustedName({ name, noteClass }: { name: string; noteClass?: string }) {
  return (
    <>
      <q translate="no">{shownDeviceName(name)}</q>
      {noteClass === undefined ? null : (
        <>
          {' '}
          <span className={noteClass}>{NOT_VERIFIED}</span>
        </>
      )}
    </>
  );
}
