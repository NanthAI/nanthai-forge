// SPDX-License-Identifier: Apache-2.0
// Delete forever: a sheet with the typed name (SPEC-01-trash, "Screens" 5). The name is the slug the server already
// checks as `confirm`. A person approves it in the browser; the server refuses a device or agent sign-in.
import { useId, useState, type FormEvent } from 'react';
import { Key, Sheet } from '../../ds';
import './trash.css';
import { hostedError } from '../../snapshot';

export function DeleteForever({
  name,
  confirm,
  size,
  remove,
  close,
}: {
  name: string;
  /** The text to type: the project's slug (or its name when it has none). */
  confirm: string;
  /** Stored size in words, or "not reported". */
  size: string;
  remove: (typed: string) => Promise<void>;
  close: () => void;
}) {
  const form = useId();
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const ready = !pending && typed.trim() === confirm;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    setError('');
    try {
      await remove(typed);
    } catch (failure) {
      setError(hostedError(failure));
      setPending(false);
    }
  };
  return (
    <Sheet
      open
      title="Delete forever"
      onOpenChange={open => {
        if (!open && !pending) close();
      }}
      footer={
        <>
          <Key kind="danger" type="submit" form={form} disabled={!ready}>
            {pending ? 'Deleting…' : 'Delete forever'}
          </Key>
          <Key kind="ghost" keys="Esc" disabled={pending} onClick={close}>
            Keep it in the trash
          </Key>
        </>
      }
    >
      <form id={form} className="trash-sheet" onSubmit={submit}>
        <h3 dir="auto">Delete {name} for good?</h3>
        <p>
          <strong>This cannot be undone.</strong> It removes the source, every Lane and landing, its Items and{' '}
          {size === 'not reported' ? 'all of its stored data' : `${size} of stored data`}. Copies on people's
          own machines are not touched.
        </p>
        <label className="f">
          <span>Type the project's name to delete it</span>
          <input
            className="inp mono"
            value={typed}
            onChange={event => setTyped(event.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            disabled={pending}
            autoFocus
          />
          <span className="help" dir="auto" translate="no">
            {confirm}
          </span>
        </label>
        {error ? (
          <p className="pf" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Sheet>
  );
}
