// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// New Item (Item d3357f40): a title, an Initiative, a type and Done-when lines, written as one put-planning-item whose
// operation id is kept for a retry, so a lost reply never files the Item twice.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Key, Sheet } from '../../ds';
import { defaultItemTypes, type PlanRow } from '../../../../src/planning-model';
import { captureBody, matches, type PlanView } from './model';
import type { Put } from './Plan';
import { ItemPicker, type SearchOpenItems } from './ItemPicker';
import { parentRefusal } from './hierarchy';

/** New Item: a person's Item starts Planned (owner decision 1.3) and lands last in its group, since its creation
 * position sorts after every stored rank. Matching open Items are shown while typing. */
export function Capture({
  open,
  onOpenChange,
  view,
  put,
  search,
  announce,
  initiative = '',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: PlanView;
  put: Put;
  search?: SearchOpenItems | undefined;
  announce: (text: string) => void;
  /** The Initiative a new Item starts in (the Initiative page's New Item here). */
  initiative?: string;
}) {
  const [kind, setKind] = useState<'issue' | 'initiative'>('issue');
  const [parent, setParent] = useState<PlanRow>();
  const [pickingParent, setPickingParent] = useState(false);
  const [title, setTitle] = useState('');
  const [initiativeId, setInitiativeId] = useState(initiative);
  useEffect(() => setInitiativeId(initiative), [initiative]);
  const [type, setType] = useState('');
  const [doneWhen, setDoneWhen] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [captured, setCaptured] = useState(0);
  const titleField = useRef<HTMLInputElement>(null);
  // One operation per Item written here, so a retry after a lost reply never files it twice.
  const pending = useRef<{ itemId: string; operationId: string; key: string } | null>(null);
  const initiatives = view.groups.flatMap(group => (group.initiative ? [group.initiative] : []));
  const similar =
    kind === 'issue' && title.trim().length >= 3
      ? [...view.byId.values()].filter(row => row.kind === 'issue' && matches(row, title.trim())).slice(0, 3)
      : [];
  const reset = () => {
    setKind('issue');
    setParent(undefined);
    setInitiativeId(initiative);
    setConfirmation('');
    setCaptured(0);
    setPickingParent(false);
    setTitle('');
    setDoneWhen('');
    setDescription('');
    setType('');
    setError('');
    pending.current = null;
  };
  const close = () => {
    if (captured) announce(`${captured} ${captured === 1 ? 'Item' : 'Items'} planned.`);
    reset();
    onOpenChange(false);
  };
  const submit = async (event: FormEvent, keepCapturing = false) => {
    event.preventDefault();
    const text = title.trim();
    if (!text || busy) return;
    const fields =
      kind === 'initiative'
        ? { body: description.trim() }
        : {
            body: [description.trim(), captureBody(doneWhen)].filter(Boolean).join('\n\n'),
            initiativeId: parent ? (parent.initiativeId ?? null) : initiativeId || null,
            ...(parent ? { parentId: parent.id } : {}),
            ...(type ? { type } : {}),
          };
    const key = JSON.stringify([text, kind, fields]);
    if (pending.current?.key !== key)
      pending.current = { itemId: crypto.randomUUID(), operationId: crypto.randomUUID(), key };
    const request = pending.current;
    setBusy(true);
    setError('');
    setConfirmation('');
    try {
      await put(
        {
          itemId: request.itemId,
          expectedVersion: 0,
          kind,
          title: text,
          status: 'open',
          ...fields,
        },
        request.operationId,
      );
      const message = kind === 'initiative' ? `Created Initiative “${text}”.` : `${text} planned.`;
      if (pending.current !== request) {
        // The sheet was dismissed while this save was in flight; don't touch a new draft.
        announce(message);
      } else if (keepCapturing) {
        pending.current = null;
        setTitle(value => (value === title ? '' : value));
        setDescription(value => (value === description ? '' : value));
        setDoneWhen(value => (value === doneWhen ? '' : value));
        setType(value => (value === type ? '' : value));
        setPickingParent(false);
        const count = captured + 1;
        setCaptured(count);
        setConfirmation(count === 1 ? message : `${message} ${count} Items planned in this sheet.`);
        titleField.current?.focus();
      } else {
        reset();
        announce(message);
        onOpenChange(false);
      }
    } catch {
      if (pending.current === request)
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
      onOpenChange={next => (next ? onOpenChange(true) : close())}
      title="New Item"
      footer={
        <>
          <Key onClick={close}>Cancel</Key>
          <Key kind="primary" type="submit" form="plan-capture" disabled={!title.trim() || busy}>
            {busy ? 'Filing…' : kind === 'initiative' ? 'Create Initiative' : 'Plan it'}
          </Key>
        </>
      }
    >
      <form id="plan-capture" className="plan-capture" onSubmit={event => void submit(event)}>
        <div className="seg" role="group" aria-label="Create kind">
          <button type="button" aria-pressed={kind === 'issue'} onClick={() => setKind('issue')}>
            Item
          </button>
          <button type="button" aria-pressed={kind === 'initiative'} onClick={() => setKind('initiative')}>
            Initiative
          </button>
        </div>
        <label>
          <span>Title</span>
          <input
            className="inp"
            ref={titleField}
            value={title}
            onChange={event => setTitle(event.target.value)}
            onKeyDown={event => {
              if (
                kind === 'issue' &&
                event.key === 'Enter' &&
                !event.nativeEvent.isComposing &&
                event.nativeEvent.keyCode !== 229 &&
                title.trim()
              )
                void submit(event, true);
            }}
            required
            autoFocus
          />
        </label>
        <div className={confirmation ? 't2' : 'sr'} role="status" aria-live="polite">
          {confirmation}
        </div>
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
        {kind === 'issue' ? (
          <>
            <label>
              <span>Initiative{parent ? ' (from its parent)' : ''}</span>
              <select
                className="inp"
                disabled={Boolean(parent)}
                value={parent ? (parent.initiativeId ?? '') : initiativeId}
                onChange={event => setInitiativeId(event.target.value)}
              >
                <option value="">No Initiative</option>
                {initiatives.map(row => (
                  <option key={row.id} value={row.id}>
                    {row.title}
                  </option>
                ))}
                {parent?.initiativeId && !initiatives.some(row => row.id === parent.initiativeId) ? (
                  <option value={parent.initiativeId}>Initiative not shown</option>
                ) : null}
              </select>
            </label>
            <div className="plan-capture-parent">
              <div className="plan-parent">
                <span>Parent</span>
                {parent ? (
                  <span dir="auto">{parent.title}</span>
                ) : (
                  <span className="t2">none, top level</span>
                )}
                <Key size="sm" onClick={() => setPickingParent(true)}>
                  {parent ? 'Change…' : 'Set parent…'}
                </Key>
                {parent ? (
                  <Key size="sm" onClick={() => setParent(undefined)}>
                    Clear
                  </Key>
                ) : null}
              </div>
              {pickingParent ? (
                <ItemPicker
                  embedded
                  label="Find a parent"
                  view={view}
                  search={search}
                  refusal={row => parentRefusal(view, undefined, row)}
                  cancel={() => setPickingParent(false)}
                  choose={row => {
                    setParent(row);
                    setPickingParent(false);
                  }}
                />
              ) : null}
            </div>
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
          </>
        ) : null}
        <label>
          <span>{kind === 'initiative' ? 'Text' : 'Description (optional)'}</span>
          <textarea
            className="inp"
            rows={3}
            value={description}
            onChange={event => setDescription(event.target.value)}
          />
        </label>
        {kind === 'issue' ? (
          <label>
            <span>Done when (one line each)</span>
            <textarea
              className="inp"
              rows={3}
              value={doneWhen}
              onChange={event => setDoneWhen(event.target.value)}
            />
          </label>
        ) : null}
        {error ? (
          <p className="pf" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Sheet>
  );
}
