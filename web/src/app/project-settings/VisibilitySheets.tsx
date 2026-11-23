// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Settings > Project, Visibility (Item 966cb821): the two confirmations. Making a project public types its name, like
// Delete forever (SPEC-01-trash); making it private is one button. A person approves both in the browser; the server
// refuses a device or agent sign-in.
import { useId, useState, type FormEvent } from 'react';
import { Key, Sheet } from '../../ds';
import { hostedError } from '../../snapshot';
import '../trash/trash.css';

export function MakePublic({
  name,
  apply,
  close,
}: {
  name: string;
  apply: (typed: string) => Promise<void>;
  close: () => void;
}) {
  const form = useId();
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const ready = !pending && typed.trim() === name;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    setError('');
    try {
      await apply(typed);
    } catch (failure) {
      setError(hostedError(failure));
      setPending(false);
    }
  };
  return (
    <Sheet
      open
      title="Make public"
      onOpenChange={open => {
        if (!open && !pending) close();
      }}
      footer={
        <>
          <Key type="submit" form={form} disabled={!ready}>
            {pending ? 'Making public…' : 'Make public'}
          </Key>
          <Key kind="ghost" keys="Esc" disabled={pending} onClick={close}>
            Keep it private
          </Key>
        </>
      }
    >
      <form id={form} className="trash-sheet" onSubmit={submit}>
        <h3 dir="auto">Make {name} public?</h3>
        <p>
          <strong>Anyone can then read its source, history, Lanes and plan.</strong> Only you and the people
          you invite can change it. You can make it private again at any time.
        </p>
        <label className="f">
          <span>Type the project's name to make it public</span>
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
            {name}
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

export function MakePrivate({
  name,
  apply,
  close,
}: {
  name: string;
  apply: () => Promise<void>;
  close: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setPending(true);
    setError('');
    try {
      await apply();
    } catch (failure) {
      setError(hostedError(failure));
      setPending(false);
    }
  };
  return (
    <Sheet
      open
      title="Make private"
      onOpenChange={open => {
        if (!open && !pending) close();
      }}
      footer={
        <>
          <Key disabled={pending} onClick={() => void go()}>
            {pending ? 'Making private…' : 'Make private'}
          </Key>
          <Key kind="ghost" keys="Esc" disabled={pending} onClick={close} autoFocus>
            Keep it public
          </Key>
        </>
      }
    >
      <div className="trash-sheet">
        <h3 dir="auto">Make {name} private?</h3>
        <p>
          <strong>Only you and the people you invited can see it.</strong> Its public pages and listing stop
          now; cached copies can take up to a minute to clear. You can make it public again at any time.
        </p>
        {error ? (
          <p className="pf" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
