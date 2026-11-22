// SPDX-License-Identifier: Apache-2.0
// The command chip of the Trash (SPEC-01-trash): what an agent runs for the same request, and what it may do alone.
// It opens with `c` and closes with `c` or Esc. The output is the documented commands (docs/operations.md); no new flag.
import { useEffect, useId, useState } from 'react';
import { Key } from '../../ds';

const OUTPUT = `$ nforge host . --delete-projects --trash
request ID  every project in the trash, the list fixed when it is made, good for 30 minutes
approve   a person only, in the browser: /account?request=ID
withdraw  nforge host . --delete-projects --withdraw ID
wait      nforge host . --delete-projects --wait ID      one subscription, no polling

The same actions, for an agent
move to trash   allowed for a device of the owner. See docs/operations.md, "Project retention and restore".
restore         allowed for a device of the owner, until the deadline.
delete forever  a person only. An agent prepares the request above; the owner approves it once.
empty trash     a person only. The same request, with --trash.`;

/** The chip's open state and its `c` / Esc keys; the key goes among the page tools, the output under the head. */
export function useCommandChip() {
  const [open, setOpen] = useState(false);
  const id = useId();
  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if ((event.target as HTMLElement | null)?.closest?.('input, textarea, select, [role="dialog"]')) return;
      if (event.key === 'c') setOpen(was => !was);
      else if (event.key === 'Escape') setOpen(false);
    };
    addEventListener('keydown', press);
    return () => removeEventListener('keydown', press);
  }, []);
  return {
    key: (
      <Key
        className="cli"
        aria-controls={id}
        aria-expanded={open}
        title="What an agent runs  c"
        onClick={() => setOpen(!open)}
      >
        <span className="mono">nforge host . --delete-projects --trash</span>
      </Key>
    ),
    output: open ? (
      <pre className="cli-out mono" id={id} tabIndex={0}>
        {OUTPUT}
      </pre>
    ) : null,
  };
}
