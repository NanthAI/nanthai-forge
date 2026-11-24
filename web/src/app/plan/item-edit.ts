// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useRef, useState } from 'react';
import { hostedError, hostedErrorCode } from '../../snapshot';
import type { BatchWrite } from '../../../../src/planning-batch';
import { planningLineEvidence } from '../../../../src/planning-line-evidence';
import {
  appendItemLine,
  changeItemLine,
  itemBody,
  movedTo,
  replaceItemText,
  type ItemLine,
} from './item-body';
import type { BatchOutcome, FullItem, RunBatch } from './batch';

export type LineAction = 'wording' | 'tick' | 'move' | 'reopen' | 'remove';
export type ItemDraft = { base: FullItem; value: string } & (
  | { kind: 'text' | 'add' }
  | { kind: LineAction; line: ItemLine }
);
type Conflict = { latest?: FullItem; version?: number | undefined; compared?: true };
export type ItemEdits = ReturnType<typeof useItemEdits>;
export type EditItemPorts = {
  run: RunBatch;
  undo: (outcome: BatchOutcome, words: string, onUndo?: () => void) => void;
  compare?: ((base: number, current: number | undefined) => void) | undefined;
};

function patch(item: FullItem, draft: ItemDraft): BatchWrite[] | null {
  const value = draft.value.trim();
  let body: string | null;
  if (!('line' in draft)) {
    body = draft.kind === 'text' ? replaceItemText(item.body, draft.value) : appendItemLine(item.body, value);
  } else {
    const line = draft.base.body === item.body ? draft.line : unchangedLine(draft, item);
    if (!line) return null;
    const target = line.state === 'moved' ? movedTo(line.text) : null;
    body = changeItemLine(
      item.body,
      line,
      draft.kind === 'remove'
        ? { remove: true }
        : draft.kind === 'move'
          ? { mark: '~', ...(value ? { text: `${line.text} (moved to Item ${value})` } : {}) }
          : draft.kind === 'reopen'
            ? { mark: ' ', ...(target ? { text: line.text.slice(0, target.index) } : {}) }
            : draft.kind === 'tick'
              ? { mark: 'x' }
              : { text: target ? `${value} (moved to Item ${target.id})` : value },
    );
    if (body !== null && draft.kind === 'tick')
      return [
        { action: 'put-planning-item', itemId: item.id, expectedVersion: item.version, body },
        {
          action: 'comment-planning-item',
          itemId: item.id,
          text: value,
          decision: true,
          line: planningLineEvidence(line.position, line.text),
        },
      ];
  }
  return body === null
    ? null
    : [{ action: 'put-planning-item', itemId: item.id, expectedVersion: item.version, body }];
}

function unchangedLine(draft: Extract<ItemDraft, { line: ItemLine }>, item: FullItem) {
  // A duplicate can be reordered or removed without a distinguishable identity. Do not guess.
  if (itemBody(draft.base.body).lines.filter(line => line.raw === draft.line.raw).length !== 1) return;
  const matching = itemBody(item.body).lines.filter(line => line.raw === draft.line.raw);
  return matching.length === 1 ? matching[0] : undefined;
}

export function useItemEdits(ports: EditItemPorts | undefined, refresh: () => Promise<FullItem>) {
  const [draft, setDraft] = useState<ItemDraft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<Conflict>();
  const pending = useRef<{ key: string; id: string } | undefined>(undefined);
  const writing = useRef(false);
  const reset = (next?: ItemDraft) => {
    setDraft(next);
    setError('');
    setConflict(undefined);
  };
  const words = (value: string) => {
    if (draft) setDraft({ ...draft, value });
    setError('');
  };
  const save = async (submitted: ItemDraft) => {
    if (!ports || writing.current || conflict) return;
    writing.current = true;
    setBusy(true);
    setError('');
    // Even an immediate action gets a retained draft when refused, so it can be compared or retried.
    setDraft(submitted);
    let next = submitted.base;
    let rebased = false;
    try {
      for (;;) {
        const writes = patch(next, submitted);
        if (!writes) {
          setConflict({ latest: next });
          return;
        }
        const key = JSON.stringify(writes);
        if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() };
        let outcome: BatchOutcome | undefined;
        try {
          outcome = await ports.run(writes, { operationId: pending.current.id });
        } catch (cause) {
          if (hostedErrorCode(cause) !== 'ITEM_CHANGED') throw cause;
        }
        const refusal = outcome?.results.find(result => result.outcome === 'refused');
        if (refusal && refusal.code !== 'ITEM_CHANGED') {
          setError(refusal.message ?? 'The change was refused. Your draft is still here.');
          return;
        }
        if (outcome && !refusal) {
          pending.current = undefined;
          if (submitted.kind === 'remove' || submitted.kind === 'reopen')
            ports.undo(outcome, submitted.kind === 'remove' ? 'Removed the line.' : 'Reopened the line.');
          if (submitted.kind === 'add') {
            // Keep the input open; its next submission uses the newly saved body, even before the live row updates.
            const write = writes[0];
            reset({
              kind: 'add',
              value: '',
              base: {
                ...next,
                body: write?.action === 'put-planning-item' ? write.body! : next.body,
                version: outcome.results[0]?.version ?? next.version + 1,
              },
            });
          } else reset();
          return;
        }
        const stale = refusal?.currentVersion;
        const latest = await refresh().catch(() => undefined);
        if (!latest || latest.version <= next.version || rebased || submitted.kind === 'text') {
          setConflict({ ...(latest && latest.version > next.version ? { latest } : {}), version: stale });
          return;
        }
        if ('line' in submitted) {
          const line = unchangedLine(submitted, latest);
          if (!line) {
            setConflict({ latest });
            return;
          }
          submitted = { ...submitted, base: latest, line };
        } else submitted = { ...submitted, base: latest };
        setDraft(submitted);
        next = latest;
        rebased = true;
      }
    } catch (cause) {
      setError(
        hostedErrorCode(cause)
          ? hostedError(cause)
          : 'Forge could not confirm the change. Your draft is still here; retry to check the original save.',
      );
    } finally {
      writing.current = false;
      setBusy(false);
    }
  };
  const basis = draft && conflict?.latest;
  const line = basis && 'line' in draft ? unchangedLine(draft, basis) : undefined;
  const resume =
    basis && draft && conflict?.compared && (!('line' in draft) || line)
      ? () => reset({ ...draft, base: basis, ...(line ? { line } : {}) })
      : undefined;
  return {
    draft,
    busy,
    error,
    conflict,
    canEdit: Boolean(ports),
    compare:
      ports?.compare && conflict
        ? (base: number, current: number | undefined) => {
            ports.compare?.(base, current);
            setConflict({ ...conflict, compared: true });
          }
        : undefined,
    resume,
    reset,
    words,
    save,
  };
}
