// SPDX-License-Identifier: Apache-2.0
// The archive file picker (Item 966cb821): a design-system button and the chosen file's name. The browser's own file
// input renders its words in the OS language ("Scegli file"), so it stays hidden and this button opens it.
import { useEffect, useId, useRef, useState } from 'react';
import { Key } from '../../ds';

export function ArchivePicker({
  accept,
  disabled,
  settled,
  choose,
}: {
  accept: string;
  disabled: boolean;
  /** The last choice is stored or dropped with nothing to show: the name goes away and the same file can be chosen again. */
  settled: boolean;
  choose: (file: File | undefined) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const named = useId();
  useEffect(() => {
    if (!settled) return;
    setName('');
    if (input.current) input.current.value = '';
  }, [settled]);
  return (
    <div className="pick">
      <input
        ref={input}
        type="file"
        hidden
        tabIndex={-1}
        accept={accept}
        disabled={disabled}
        onChange={event => {
          const file = event.target.files?.[0];
          setName(file?.name ?? '');
          choose(file);
        }}
      />
      <Key size="sm" disabled={disabled} aria-describedby={named} onClick={() => input.current?.click()}>
        Choose archive
      </Key>
      <span id={named} className="meta pick-name" translate="no">
        {name || 'No file chosen'}
      </span>
    </div>
  );
}
