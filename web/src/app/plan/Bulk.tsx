// SPDX-License-Identifier: Apache-2.0
// The bulk bar (Item 65b0e706, DESIGN.md rules 6, 7 and 18): only the ticked rows change, each action is one batch
// call with per-Item results, and the reply's one Undo waits in a toast for 10 seconds. A row someone else changed
// meanwhile is refused by its version and named; their change stays.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Key, Menu, Sheet } from '../../ds';
import {
  batchSentence,
  changeEach,
  closeAnywayReason,
  closeMany,
  doneWhenLines,
  mergeItems,
  planningBatchLimit,
  splitItem,
  type BatchFields,
  type BatchWrite,
} from '../../../../src/planning-batch';
import { defaultItemTypes, type PlanRow } from '../../../../src/planning-model';
import type { BatchOutcome, FullItem, ItemComment, RunBatch } from './batch';
import type { ReadWorkers } from './workers';

export type Reads = {
  items: (ids: readonly string[]) => Promise<FullItem[]>;
  comments: (ids: readonly string[]) => Promise<{ comments: ItemComment[]; more: string[] }>;
  /** Open Lanes active in the last 48 hours, for the Owner column (workers.ts). */
  workers?: ReadWorkers;
};
type Done = (outcome: BatchOutcome, words: string) => void;

const short = (id: string) => id.slice(0, 8);
const names = (rows: readonly { title: string }[], max = 3) =>
  rows.length <= max
    ? rows.map(row => `“${row.title}”`).join(', ')
    : `${rows
        .slice(0, max)
        .map(row => `“${row.title}”`)
        .join(', ')} and ${(rows.length - max).toLocaleString()} more`;

/** What a reply says: the count sentence, then the rows that were refused, by name. */
export function outcomeWords(outcome: BatchOutcome, byId: ReadonlyMap<string, PlanRow>) {
  const refused = outcome.results.filter(result => result.outcome === 'refused');
  const moved = refused
    .filter(result => result.code === 'ITEM_CHANGED')
    .map(result => byId.get(result.itemId) ?? { title: short(result.itemId) });
  return [
    batchSentence(outcome.results),
    moved.length ? `Changed meanwhile: ${names(moved)}.` : '',
    refused.length - moved.length
      ? `Refused: ${refused
          .filter(result => result.code !== 'ITEM_CHANGED')
          .slice(0, 2)
          .map(result => result.message ?? result.code)
          .join(' ')}`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function BulkBar({
  rows,
  loaded,
  initiatives,
  parents,
  owners,
  viewer,
  run,
  reads,
  onDone,
  onSelectLoaded,
  onClear,
}: {
  rows: readonly PlanRow[];
  /** How many matching rows are loaded: "select all" names this count and stops at the batch limit. */
  loaded: number;
  initiatives: readonly PlanRow[];
  /** Top-level open Items, which can take sub-items without making a loop. */
  parents: readonly PlanRow[];
  owners: readonly string[];
  viewer: string | undefined;
  run: RunBatch;
  reads: Reads;
  onDone: Done;
  onSelectLoaded: () => void;
  onClear: () => void;
}) {
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<'close' | 'merge' | 'split' | null>(null);
  const [error, setError] = useState('');
  const reason = why.trim() ? { reason: why.trim().slice(0, 500) } : {};
  const go = async (writes: BatchWrite[], words?: string) => {
    setBusy(true);
    setError('');
    try {
      const outcome = await run(writes);
      onDone(outcome, words ?? '');
      setWhy('');
      return outcome;
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Forge could not change these Items; nothing changed.',
      );
      return null;
    } finally {
      setBusy(false);
    }
  };
  const change = (fields: BatchFields) => go(changeEach(rows, { ...fields, ...reason }));
  const move = (initiative: PlanRow | null) => {
    const writes: BatchWrite[] = changeEach(rows, { initiativeId: initiative?.id ?? null, ...reason });
    // The scope change shows on both Initiatives: one comment on each, naming what moved in or out.
    const from = new Map<string, PlanRow[]>();
    for (const row of rows)
      if (row.initiativeId && row.initiativeId !== initiative?.id)
        from.set(row.initiativeId, [...(from.get(row.initiativeId) ?? []), row]);
    const why = reason.reason ? ` Why: ${reason.reason}` : '';
    for (const [id, moved] of from)
      writes.push({
        action: 'comment-planning-item',
        itemId: id,
        text: `Moved out to ${initiative ? initiative.title : 'No Initiative'}: ${moved.map(row => `${row.title} (${short(row.id)})`).join(', ')}.${why}`,
      });
    const coming = rows.filter(row => row.initiativeId !== initiative?.id);
    if (initiative && coming.length)
      writes.push({
        action: 'comment-planning-item',
        itemId: initiative.id,
        text: `Moved in: ${coming.map(row => `${row.title} (${short(row.id)})`).join(', ')}.${why}`,
      });
    return go(writes.slice(0, planningBatchLimit));
  };
  // Re-parent within one Initiative only: the sub-item stays where its parent is.
  const shared = new Set(rows.map(row => row.initiativeId ?? null));
  const picked = new Set(rows.map(row => row.id));
  const under =
    shared.size === 1
      ? parents
          .filter(row => !picked.has(row.id) && (row.initiativeId ?? null) === [...shared][0])
          .slice(0, 30)
      : [];
  const mine = viewer ? `@${viewer.replace(/^@/, '')}` : undefined;
  const people = [...new Set([...(mine ? [mine] : []), ...owners])].slice(0, 12);
  const n = rows.length;
  return (
    <div className="bulk plan-bulk" role="region" aria-label="Change the selected Items">
      <b>{n.toLocaleString()} selected</b>
      <Menu
        label="Move to…"
        items={[
          ...initiatives.map(initiative => ({
            id: initiative.id,
            label: initiative.title,
            onAction: () => void move(initiative),
          })),
          'separator' as const,
          { id: 'none', label: 'No Initiative', onAction: () => void move(null) },
        ]}
      />
      <Menu
        label="Put under…"
        items={[
          ...under.map(parent => ({
            id: parent.id,
            label: parent.title,
            onAction: () => void change({ parentId: parent.id }),
          })),
          ...(under.length ? ['separator' as const] : []),
          { id: 'none', label: 'Top level (no parent)', onAction: () => void change({ parentId: null }) },
        ]}
      />
      <Menu
        label="Status"
        items={[
          { id: 'proposed', label: 'Proposed', onAction: () => void change({ status: 'proposed' }) },
          { id: 'open', label: 'Planned', onAction: () => void change({ status: 'open' }) },
          { id: 'in-progress', label: 'In progress', onAction: () => void change({ status: 'in-progress' }) },
          'separator' as const,
          {
            id: 'abandoned',
            label: 'Won’t do',
            onAction: () => void change({ status: 'abandoned', reason: reason.reason ?? 'Won’t do' }),
          },
        ]}
      />
      <Menu
        label="Assign"
        items={[
          ...people.map(owner => ({ id: owner, label: owner, onAction: () => void change({ owner }) })),
          'separator' as const,
          { id: 'none', label: 'No one', onAction: () => void change({ owner: null }) },
        ]}
      />
      <Menu
        label="Type"
        items={[
          ...defaultItemTypes.map(type => ({
            id: type,
            label: type[0]!.toUpperCase() + type.slice(1),
            onAction: () => void change({ type }),
          })),
          'separator' as const,
          { id: 'none', label: 'No type', onAction: () => void change({ type: null }) },
        ]}
      />
      <Key size="sm" onClick={() => setSheet('close')} disabled={busy}>
        Close with one note
      </Key>
      <Menu
        label="More actions"
        className="btn ghost sm"
        items={[
          { id: 'merge', label: 'Merge…', disabled: n < 2 || n > 10, onAction: () => setSheet('merge') },
          { id: 'split', label: 'Split…', disabled: n !== 1, onAction: () => setSheet('split') },
        ]}
      >
        ⋯
      </Menu>
      <label className="plan-why">
        <span className="sr">Reason, optional, kept on each change</span>
        <input
          className="inp"
          placeholder="Why (optional)"
          maxLength={500}
          value={why}
          onChange={event => setWhy(event.target.value)}
        />
      </label>
      {loaded > n ? (
        <button type="button" className="btn ghost sm" onClick={onSelectLoaded}>
          Select all {Math.min(loaded, planningBatchLimit).toLocaleString()} loaded
          {loaded > planningBatchLimit ? ` (first ${planningBatchLimit} of ${loaded.toLocaleString()})` : ''}
        </button>
      ) : null}
      <button type="button" className="btn ghost sm" aria-label="Clear the selection" onClick={onClear}>
        ×
      </button>
      {busy ? (
        <span className="t3" aria-live="polite">
          Changing…
        </span>
      ) : null}
      {error ? (
        <span className="pf" role="alert">
          {error}
        </span>
      ) : null}
      <CloseSheet
        open={sheet === 'close'}
        onOpenChange={open => setSheet(open ? 'close' : null)}
        rows={rows}
        go={go}
      />
      {sheet === 'merge' ? (
        <MergeSheet
          onOpenChange={open => setSheet(open ? 'merge' : null)}
          rows={rows}
          reads={reads}
          go={go}
        />
      ) : null}
      {sheet === 'split' && rows[0] ? (
        <SplitSheet
          onOpenChange={open => setSheet(open ? 'split' : null)}
          row={rows[0]}
          reads={reads}
          go={go}
        />
      ) : null}
    </div>
  );
}

type Go = (writes: BatchWrite[], words?: string) => Promise<BatchOutcome | null>;

/** Close many with one note: names what had Done-when lines open, closes anyway in one press with the standard
 * reason, and offers (never forces) one follow-up Item for what stayed open. */
function CloseSheet({
  open,
  onOpenChange,
  rows,
  go,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: readonly PlanRow[];
  go: Go;
}) {
  const [note, setNote] = useState('');
  const [left, setLeft] = useState<PlanRow[] | null>(null);
  const { writes, openLines } = useMemo(() => closeMany(rows, note), [rows, note]);
  const withOpen = rows.filter(row => openLines.some(entry => entry.id === row.id));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const outcome = await go(writes);
    if (!outcome) return;
    const closed = new Set(outcome.results.filter(r => r.outcome !== 'refused').map(r => r.itemId));
    const stayed = withOpen.filter(row => closed.has(row.id));
    setNote('');
    if (stayed.length) setLeft(stayed);
    else onOpenChange(false);
  };
  const followUp = async () => {
    if (!left) return;
    const id = crypto.randomUUID();
    await go([
      {
        action: 'put-planning-item',
        itemId: id,
        expectedVersion: 0,
        kind: 'issue',
        title: `Follow-up: what ${left.length === 1 ? left[0]!.title : `${left.length} closed Items`} left open`,
        body: `Done-when lines left open when these closed:\n\n${left
          .map(
            row =>
              `- ${row.title} (${short(row.id)}): ${row.doneWhen ? row.doneWhen[1] - row.doneWhen[0] : 0} open`,
          )
          .join('\n')}\n`,
        status: 'open',
        initiativeId: left[0]!.initiativeId ?? null,
        relations: left.slice(0, 20).map(row => ({ kind: 'related' as const, id: row.id })),
      },
    ]);
    setLeft(null);
    onOpenChange(false);
  };
  return (
    <Sheet
      open={open}
      onOpenChange={next => {
        if (!next) setLeft(null);
        onOpenChange(next);
      }}
      title={
        left ? 'Closed' : `Close ${rows.length.toLocaleString()} ${rows.length === 1 ? 'Item' : 'Items'}`
      }
      footer={
        left ? (
          <>
            <Key onClick={() => (setLeft(null), onOpenChange(false))}>No follow-up</Key>
            <Key kind="primary" onClick={() => void followUp()}>
              Add one follow-up Item
            </Key>
          </>
        ) : (
          <>
            <Key onClick={() => onOpenChange(false)}>Cancel</Key>
            <Key kind="primary" type="submit" form="plan-close-many">
              {withOpen.length && !note.trim() ? 'Close anyway' : 'Close'}
            </Key>
          </>
        )
      }
    >
      {left ? (
        <p>
          {left.length === 1 ? 'This one closed' : `${left.length.toLocaleString()} closed`} with Done-when
          lines still open: {names(left)}. A follow-up Item can carry them; nothing else is needed.
        </p>
      ) : (
        <form id="plan-close-many" className="plan-capture" onSubmit={event => void submit(event)}>
          <label>
            <span>One note for all of them (optional)</span>
            <textarea
              className="inp"
              rows={3}
              maxLength={500}
              value={note}
              onChange={event => setNote(event.target.value)}
            />
          </label>
          {withOpen.length ? (
            <p className="t2">
              {names(withOpen)} {withOpen.length === 1 ? 'has' : 'have'} Done-when lines open. Without a note
              they close with the reason “{closeAnywayReason}”.
            </p>
          ) : null}
        </form>
      )}
    </Sheet>
  );
}

/** Merge: one survivor keeps its Item; the others are closed as duplicates of it, their Lane links and comments
 * carried over and a duplicate link left behind. */
function MergeSheet({
  onOpenChange,
  rows,
  reads,
  go,
}: {
  onOpenChange: (open: boolean) => void;
  rows: readonly PlanRow[];
  reads: Reads;
  go: Go;
}) {
  const [survivor, setSurvivor] = useState(rows[0]!.id);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const ids = rows.map(row => row.id);
      const items = await reads.items(ids);
      const keep = items.find(item => item.id === survivor)!;
      const duplicates = items.filter(item => item.id !== survivor);
      const { comments, more } = await reads.comments(duplicates.map(item => item.id));
      const writes = mergeItems(keep, duplicates, comments).slice(0, planningBatchLimit);
      const outcome = await go(
        writes,
        more.length ? `Only the first 50 comments of ${more.map(short).join(', ')} were copied.` : '',
      );
      if (outcome) onOpenChange(false);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Forge could not read these Items; nothing changed.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      onOpenChange={onOpenChange}
      title={`Merge ${rows.length.toLocaleString()} Items`}
      footer={
        <>
          <Key onClick={() => onOpenChange(false)}>Cancel</Key>
          <Key kind="primary" type="submit" form="plan-merge" disabled={busy}>
            Merge into the one kept
          </Key>
        </>
      }
    >
      <form id="plan-merge" className="plan-capture" onSubmit={event => void submit(event)}>
        <fieldset className="plan-pick">
          <legend>Keep</legend>
          {rows.map(row => (
            <label key={row.id}>
              <input
                type="radio"
                name="survivor"
                checked={survivor === row.id}
                onChange={() => setSurvivor(row.id)}
              />
              <span dir="auto">{row.title}</span> <span className="mono t3">{short(row.id)}</span>
            </label>
          ))}
        </fieldset>
        <p className="t2">
          The others close as duplicates of it. Their comments and Lane links move to it, and each keeps a
          duplicate link back.
        </p>
        {error ? (
          <p className="pf" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Sheet>
  );
}

/** Split: each Done-when line goes to the Item itself or to one new part. */
export function SplitSheet({
  onOpenChange,
  row,
  reads,
  go,
}: {
  onOpenChange: (open: boolean) => void;
  row: Pick<PlanRow, 'id' | 'title'>;
  reads: Reads;
  go: Go;
}) {
  const [item, setItem] = useState<FullItem | null>(null);
  const [parts, setParts] = useState<string[]>(['']);
  const [assign, setAssign] = useState<number[]>([]);
  const [error, setError] = useState('');
  // The ids of the new parts are made once, so pressing Split again after a dropped reply makes no extra Items.
  const [ids] = useState(() => Array.from({ length: 10 }, () => crypto.randomUUID()));
  useEffect(() => {
    let live = true;
    reads.items([row.id]).then(
      ([full]) => {
        if (!live || !full) return;
        setItem(full);
        setAssign(doneWhenLines(full.body).map(() => 0));
      },
      failure =>
        live && setError(failure instanceof Error ? failure.message : 'Forge could not read this Item.'),
    );
    return () => {
      live = false;
    };
  }, [row.id]);
  const lines = item ? doneWhenLines(item.body) : [];
  const ready = item && parts.every(part => part.trim()) && assign.some(part => part > 0);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!item || !ready) return;
    const writes = splitItem(
      item,
      parts.map(title => ({ title })),
      assign,
      ids.slice(0, parts.length),
    );
    if (await go(writes)) onOpenChange(false);
  };
  return (
    <Sheet
      open
      onOpenChange={onOpenChange}
      title={`Split “${row.title}”`}
      footer={
        <>
          <Key onClick={() => onOpenChange(false)}>Cancel</Key>
          <Key kind="primary" type="submit" form="plan-split" disabled={!ready}>
            Split into {(parts.length + 1).toLocaleString()}
          </Key>
        </>
      }
    >
      <form id="plan-split" className="plan-capture" onSubmit={event => void submit(event)}>
        {!item ? (
          <p className="t2" aria-busy={!error}>
            {error || 'Reading the Item…'}
          </p>
        ) : !lines.length ? (
          <p className="t2">This Item has no Done-when lines to split.</p>
        ) : (
          <>
            {parts.map((part, index) => (
              <label key={index}>
                <span>Part {index + 2} title</span>
                <input
                  className="inp"
                  value={part}
                  maxLength={200}
                  onChange={event =>
                    setParts(previous =>
                      previous.map((entry, at) => (at === index ? event.target.value : entry)),
                    )
                  }
                />
              </label>
            ))}
            {parts.length < 10 ? (
              <button type="button" className="lk" onClick={() => setParts(previous => [...previous, ''])}>
                Add a part
              </button>
            ) : null}
            <fieldset className="plan-pick">
              <legend>Done when, line by line</legend>
              {lines.map((line, index) => (
                <label key={line.line} className="plan-split-line">
                  <span dir="auto">
                    {line.ticked ? '☑' : '☐'} {line.text}
                  </span>
                  <select
                    className="inp"
                    value={assign[index] ?? 0}
                    onChange={event =>
                      setAssign(previous =>
                        previous.map((entry, at) => (at === index ? Number(event.target.value) : entry)),
                      )
                    }
                  >
                    <option value={0}>Stays here</option>
                    {parts.map((part, at) => (
                      <option key={at} value={at + 1}>
                        {part.trim() || `Part ${at + 2}`}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </fieldset>
          </>
        )}
        {error && item ? (
          <p className="pf" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Sheet>
  );
}

/** Undo first (DESIGN.md rule 18): the reply as a toast for 10 seconds with its one Undo. */
export function UndoToast({
  words,
  outcome,
  run,
  onGone,
  byId,
}: {
  words: string;
  outcome: BatchOutcome;
  run: RunBatch;
  onGone: (words?: string) => void;
  byId: ReadonlyMap<string, PlanRow>;
}) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // A timer only while a toast is showing after an action; an idle screen has none.
    const timer = setTimeout(() => onGone(), 10_000);
    return () => clearTimeout(timer);
  }, [outcome]);
  const undo = async () => {
    setBusy(true);
    try {
      const back = await run(outcome.undo);
      onGone(
        `Undone. ${outcomeWords(back, byId)}${outcome.kept ? ` ${outcome.kept.toLocaleString()} copied comments stay.` : ''}`,
      );
    } catch {
      onGone('Forge could not undo; the changes stay.');
    }
  };
  return (
    <div className="toasts" role="status">
      <div className="toast">
        <span>{words}</span>
        {outcome.undo.length ? (
          <button type="button" onClick={() => void undo()} disabled={busy}>
            Undo
          </button>
        ) : null}
      </div>
    </div>
  );
}
