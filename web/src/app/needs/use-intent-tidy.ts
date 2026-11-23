// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The state of tidying open Intents on the Loose ends page (Item fc1831eb): what the last batch changed (for Undo),
// the exact batches whose call failed (replayed as they were), and the words for the notice. The row results live in
// the page's shared `outcome` map, keyed by Intent id. Calls: one mutation per batch of 25, one transition per Undo row.
import { useState } from 'react';
import type { LeftAlone, Toast } from './LooseResult';
import type { ScreenRow } from './loose-ends';
import {
  intentBatches,
  intentWord,
  reopenIntents,
  tidyIntents,
  type IntentBatch,
  type IntentReopen,
  type IntentTidy,
  type UndoPin,
} from './loose-intents';

const count = (n: number) => `${n.toLocaleString('en')} ${n === 1 ? 'Intent' : 'Intents'}`;

export function useIntentTidy({
  epoch,
  tidy,
  reopen,
  outcome,
  setOutcome,
  setBusy,
  announce,
  setToast,
  remember,
}: {
  epoch: number | undefined;
  tidy: IntentTidy;
  reopen: IntentReopen;
  outcome: Record<string, string>;
  setOutcome: (update: (old: Record<string, string>) => Record<string, string>) => void;
  setBusy: (busy: boolean) => void;
  announce: (text: string) => void;
  setToast: (toast: Toast | null) => void;
  /** Names the rows submitted (so a notice can name them later) and clears their ticks. */
  remember: (rows: ScreenRow[]) => void;
}) {
  const [undo, setUndo] = useState<UndoPin[]>([]);
  const [done, setDone] = useState<number | null>(null);
  const [last, setLast] = useState<readonly string[]>([]);
  const [retryBatches, setRetryBatches] = useState<IntentBatch[]>([]);
  const [all, setAll] = useState(false);
  const [titles, setTitles] = useState<Record<string, string>>({});

  const bringBack = async (pins: UndoPin[]) => {
    if (epoch === undefined || !pins.length) return;
    setBusy(true);
    setToast(null);
    const results = await reopenIntents(reopen, epoch, pins);
    const back = pins.filter(pin => results[pin.intentId] === 'reopened').map(pin => pin.intentId);
    setOutcome(old => ({ ...old, ...Object.fromEntries(back.map(id => [id, 'reopened'])) }));
    const failedBack = pins.filter(pin => results[pin.intentId] === 'failed');
    setUndo(old => old.filter(pin => failedBack.some(f => f.intentId === pin.intentId)));
    setDone(old => (failedBack.length ? old : null));
    setBusy(false);
    // An Undo that could not reach some rows keeps its control: the toast names them and tries those again.
    if (failedBack.length)
      setToast({
        text: `${count(failedBack.length)} could not be reached. Nothing changed for them.`,
        undo: () => void bringBack(failedBack),
      });
    const changed = pins.length - back.length - failedBack.length;
    announce(
      `Brought back ${count(back.length)}.` +
        (changed ? ` ${changed.toLocaleString('en')} changed meanwhile and stay set aside.` : '') +
        (failedBack.length
          ? ` ${failedBack.length.toLocaleString('en')} could not be reached; Undo tries again.`
          : ''),
    );
  };

  /** Tidy rows: new batches pinned to what the reader returned, or, as a retry, the exact failed batches again. */
  const run = async (rows: ScreenRow[], retrying: IntentBatch[] = []) => {
    if (epoch === undefined) return;
    const batches = retrying.length
      ? retrying
      : intentBatches(
          epoch,
          rows.flatMap(row => (row.intent ? [row.intent] : [])),
        );
    if (!batches.length) return;
    const ids = batches.flatMap(batch => batch.ids);
    setBusy(true);
    if (rows.length) {
      remember(rows);
      setTitles(old => ({ ...old, ...Object.fromEntries(rows.map(row => [row.key, row.title])) }));
    }
    if (!retrying.length) {
      setLast(old => [...ids, ...old.filter(id => outcome[id] === 'failed' && !ids.includes(id))]);
      setAll(false);
    }
    const { results, versions, failed } = await tidyIntents(tidy, batches);
    setOutcome(old => ({ ...old, ...results }));
    setRetryBatches(old =>
      retrying.length ? failed : [...old.filter(batch => !batch.ids.some(id => ids.includes(id))), ...failed],
    );
    setBusy(false);
    const set = ids.filter(id => results[id] === 'set-aside');
    // Each Undo row has its own operation id, made once here: a retried Undo replays it and reconciles a lost reply.
    const back = set.flatMap(id =>
      versions[id] === undefined
        ? []
        : [{ intentId: id, version: versions[id]!, operationId: crypto.randomUUID() }],
    );
    const pins = retrying.length ? [...undo, ...back] : back;
    const total = (retrying.length ? (done ?? 0) : 0) + set.length;
    setUndo(pins);
    setDone(total);
    // A set-aside that fully succeeded, first try or retry, ends with Undo in reach.
    if (set.length === ids.length)
      setToast({
        text: `Set aside ${count(total)}. Every save is kept.`,
        undo: pins.length ? () => void bringBack(pins) : null,
      });
    announce(
      `${set.length.toLocaleString('en')} set aside${ids.length - set.length ? `, ${(ids.length - set.length).toLocaleString('en')} left alone, each named in the list` : ''}. Every save is kept.`,
    );
  };

  const ids = last.filter(
    id => outcome[id] && outcome[id] !== 'set-aside' && !['reopened'].includes(outcome[id]!),
  );
  const failedIds = ids.filter(id => outcome[id] === 'failed');
  const named = (all ? ids : ids.slice(0, 5)).map(id => {
    const word = intentWord(outcome[id]!).word;
    return `“${titles[id] ?? `Intent ${id.slice(0, 8)}`}” ${outcome[id] === 'failed' ? 'could not be reached' : word.replace(/^Skipped: /, 'skipped: ')}`;
  });
  const left: LeftAlone | null = ids.length
    ? {
        head: `${ids.length.toLocaleString('en')} could not be set aside`,
        lead:
          done === null
            ? ''
            : `${done.toLocaleString('en')} ${done === 1 ? 'Intent was' : 'Intents were'} set aside in your last try. `,
        named,
        more: ids.length - named.length,
        failed: failedIds.length,
        skipped: ids.length - failedIds.length,
      }
    : null;

  return {
    run,
    left,
    retry: () => void run([], retryBatches),
    seeLeft: all ? null : () => setAll(true),
    undo: undo.length ? () => void bringBack(undo) : null,
  };
}
