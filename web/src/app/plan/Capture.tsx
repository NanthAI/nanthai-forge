// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// New Item (Item d3357f40): a title, an Initiative, a type and Done-when lines, written as one put-planning-item whose
// operation id is kept for a retry, so a lost reply never files the Item twice.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Key, Sheet } from '../../ds';
import { defaultItemTypes } from '../../../../src/planning-model';
import { captureBody, matches, type PlanView } from './model';
import type { Put } from './Plan';

/** New Item: a person's Item starts Planned (owner decision 1.3) and lands last in its group, since its creation
 * position sorts after every stored rank. Matching open Items are shown while typing. */
export function Capture({
  open,
  onOpenChange,
  view,
  put,
  announce,
  initiative = '',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: PlanView;
  put: Put;
  announce: (text: string) => void;
  /** The Initiative a new Item starts in (the Initiative page's New Item here). */
  initiative?: string;
}) {
  const [title, setTitle] = useState('');
  const [initiativeId, setInitiativeId] = useState(initiative);
  useEffect(() => setInitiativeId(initiative), [initiative]);
  const [type, setType] = useState('');
  const [doneWhen, setDoneWhen] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // One operation per Item written here, so a retry after a lost reply never files it twice.
  const pending = useRef<{ itemId: string; operationId: string; key: string } | null>(null);
  const initiatives = view.groups.flatMap(group => (group.initiative ? [group.initiative] : []));
  const similar =
    title.trim().length >= 3
      ? [...view.byId.values()].filter(row => row.kind === 'issue' && matches(row, title.trim())).slice(0, 3)
      : [];
  const reset = () => {
    setTitle('');
    setDoneWhen('');
    setDescription('');
    setType('');
    setError('');
    pending.current = null;
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = title.trim();
    if (!text || busy) return;
    const key = JSON.stringify([text, initiativeId, type, doneWhen, description]);
    if (pending.current?.key !== key)
      pending.current = { itemId: crypto.randomUUID(), operationId: crypto.randomUUID(), key };
    setBusy(true);
    setError('');
    try {
      await put(
        {
          itemId: pending.current.itemId,
          expectedVersion: 0,
          kind: 'issue',
          title: text,
          body: [description.trim(), captureBody(doneWhen)].filter(Boolean).join('\n\n'),
          status: 'open',
          initiativeId: initiativeId || null,
          ...(type ? { type } : {}),
        },
        pending.current.operationId,
      );
      announce(`${text} planned.`);
      reset();
      onOpenChange(false);
    } catch {
      setError(
        'Forge could not confirm the new Item. Your draft is still here; try again to check the original request.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      onOpenChange={next => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title="New Item"
      footer={
        <>
          <Key onClick={() => onOpenChange(false)}>Cancel</Key>
          <Key kind="primary" type="submit" form="plan-capture" disabled={!title.trim() || busy}>
            {busy ? 'Filing…' : 'Plan it'}
          </Key>
        </>
      }
    >
      <form id="plan-capture" className="plan-capture" onSubmit={submit}>
        <label>
          <span>Title</span>
          <input
            className="inp"
            value={title}
            onChange={event => setTitle(event.target.value)}
            required
            autoFocus
          />
        </label>
        {similar.length ? (
          <div className="plan-similar" role="status">
            <span className="t2">Already in open work:</span>
            {similar.map(row => (
              <span key={row.id} className="cut" dir="auto">
                {row.title}
              </span>
            ))}
          </div>
        ) : null}
        <label>
          <span>Initiative</span>
          <select
            className="inp"
            value={initiativeId}
            onChange={event => setInitiativeId(event.target.value)}
          >
            <option value="">No Initiative</option>
            {initiatives.map(row => (
              <option key={row.id} value={row.id}>
                {row.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Type</span>
          <select className="inp" value={type} onChange={event => setType(event.target.value)}>
            <option value="">None</option>
            {defaultItemTypes.map(name => (
              <option key={name} value={name}>
                {name[0]!.toUpperCase() + name.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Description (optional)</span>
          <textarea
            className="inp"
            rows={3}
            value={description}
            onChange={event => setDescription(event.target.value)}
          />
        </label>
        <label>
          <span>Done when (one line each)</span>
          <textarea
            className="inp"
            rows={3}
            value={doneWhen}
            onChange={event => setDoneWhen(event.target.value)}
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
