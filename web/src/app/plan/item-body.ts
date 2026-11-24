// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi

import { planningTaskLine as task, planningTaskLines } from '../../../../src/planning-search';
import { isPlanningRef } from '../../../../src/planning-id';
const heading = /^[ \t]*(?:#{1,6}[ \t]+)?Done[ -]when:?[ \t]*\r?$/i;

export type ItemLine = {
  row: number;
  position: number;
  raw: string;
  text: string;
  state: 'open' | 'done' | 'moved';
};

/** Read the same Markdown task lines as the Plan count, plus moved lines (which do not count). */
export function itemBody(body: string) {
  const rows = body.split('\n');
  const lines: ItemLine[] = [];
  const hidden = new Set<number>();
  for (const { row, raw, match, position } of planningTaskLines(rows)) {
    lines.push({
      row,
      position,
      raw,
      text: match[4]!.trim(),
      state: match[2] === ' ' ? 'open' : match[2] === '~' ? 'moved' : 'done',
    });
    hidden.add(row);
    let prev = row - 1;
    while (prev >= 0 && !rows[prev]!.trim()) prev--;
    if (prev >= 0 && heading.test(rows[prev]!)) for (let at = prev; at < row; at++) hidden.add(at);
  }
  const text = rows
    .filter((_, at) => !hidden.has(at))
    .join('\n')
    .trim();
  const indexes = [...hidden].sort((a, b) => a - b);
  const start = indexes[0];
  const end = indexes.at(-1);
  const scattered =
    start !== undefined &&
    end !== undefined &&
    rows.slice(start, end + 1).some((row, offset) => row.trim() && !hidden.has(start + offset));
  return { rows, lines, text, start, end, scattered };
}

export function replaceItemText(body: string, draft: string) {
  const { rows, start, end, scattered } = itemBody(body);
  if (start === undefined || end === undefined || scattered) return draft;
  const after = rows
    .slice(end + 1)
    .join('\n')
    .trim();
  const before = rows.slice(0, start).join('\n').trim();
  // Keep the checklist between the prose that preceded it and the prose that followed it.
  const boundary = before && after ? before.split('\n').length : before ? Infinity : 0;
  const prose = draft.trim().split('\n');
  return [
    prose.slice(0, boundary).join('\n').trim(),
    rows.slice(start, end + 1).join('\n'),
    prose.slice(boundary).join('\n').trim(),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function movedTo(text: string) {
  const match = / \(moved to Item ([\da-f-]{8,36})\)$/i.exec(text);
  return match && isPlanningRef(match[1]!) ? { id: match[1]!, index: match.index } : null;
}

export function changeItemLine(
  body: string,
  line: ItemLine,
  edit: { text?: string; mark?: ' ' | '~' | 'x'; remove?: true },
) {
  const rows = body.split('\n');
  if (rows[line.row] !== line.raw) return null;
  if (edit.remove) {
    rows.splice(line.row, 1);
    let before = line.row - 1;
    while (before >= 0 && !rows[before]!.trim()) before--;
    const next = rows.slice(line.row).find(row => row.trim());
    if (before >= 0 && heading.test(rows[before]!) && (!next || !task.test(next))) rows.splice(before, 1);
  } else
    rows[line.row] = line.raw.replace(
      task,
      (_all, head: string, mark: string, tail: string, text: string, cr: string) =>
        `${head}${edit.mark ?? mark}${tail}${edit.text ?? text}${cr}`,
    );
  return rows.join('\n');
}

export function appendItemLine(body: string, text: string) {
  const { rows, lines } = itemBody(body);
  const last = lines.at(-1);
  const row = `- [ ] ${text}`;
  if (!last) return [body.trimEnd(), `Done when:\n${row}`].filter(Boolean).join('\n\n');
  rows.splice(last.row + 1, 0, row);
  return rows.join('\n');
}
