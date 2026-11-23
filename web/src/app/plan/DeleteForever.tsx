// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useId, useState, type FormEvent } from 'react';
import type { PlanRow } from '../../../../src/planning-model';
import { Key, Sheet } from '../../ds';
import { hostedError } from '../../snapshot';

export type PurgeItem = (input: { itemId: string; version: number; confirmation: string }) => Promise<number>;

export function DeleteForever({
  row,
  purge,
  close,
  onDone,
}: {
  row: PlanRow;
  purge: PurgeItem;
  close: () => void;
  onDone: () => void;
}) {
  const form = useId();
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const ready = !pending && row.version !== undefined && typed === 'DELETE';
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || row.version === undefined) return;
    setPending(true);
    setError('');
    try {
      await purge({ itemId: row.id, version: row.version, confirmation: typed });
      onDone();
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
          <Key disabled={pending} onClick={close}>
            Cancel
          </Key>
          <Key kind="danger" type="submit" form={form} disabled={!ready}>
            {pending ? 'Deleting…' : 'Delete forever'}
          </Key>
        </>
      }
    >
      <form id={form} className="plan-capture" onSubmit={submit}>
        <p>
          <strong dir="auto">{row.title}</strong> will be permanently deleted. Its text, versions and comments
          are removed from Forge, including search, history and rebuilds. Lanes and landings that point to it
          stay, along with titles copied into commit messages or landing notes. Earlier backups and exports
          stay as they were.
        </p>
        <label>
          <span>Type DELETE to confirm</span>
          <input
            className="inp"
            value={typed}
            onChange={event => setTyped(event.target.value)}
            autoComplete="off"
            disabled={pending}
            autoFocus
          />
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
