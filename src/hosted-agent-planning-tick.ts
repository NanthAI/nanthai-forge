// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// `tick-planning-item` (Item 66667155): tick one Done-when checkbox and post its evidence as a decision comment, in one
// call. Composed from the existing put and comment writes, so no server change: the tick is a versioned put of the body,
// and a version race (ITEM_CHANGED) re-reads the Item and re-applies only this line. Loaded only by that command.
import { ForgeError, invariant } from './errors.js';

import { planningTaskLines } from './planning-search.js';

const shownLength = 80;
const maxAttempts = 6;

type Candidate = { index: number; done: boolean; text: string };
const clip = (text: string) => (text.length > shownLength ? `${text.slice(0, shownLength - 1)}…` : text);
const normal = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Tick one checkbox of a body. `line` is its 1-based position among all body checkboxes, or a unique text prefix
 * (case-insensitive, whitespace folded). A line that is already ticked stays as it is (`already`). Zero or several
 * matches throw BAD_ARGUMENT listing the open candidates (index and first 80 characters). */
export function tickBodyLine(body: string, line: number | string) {
  const rows = body.split('\n');
  const boxes: (Candidate & { row: number; replacement: string })[] = [];
  for (const { row, position, match } of planningTaskLines(rows)) {
    const [, head, mark, tail, text, cr] = match;
    if (mark === '~') continue;
    boxes.push({
      index: position,
      done: mark !== ' ',
      text: normal(text!),
      row,
      replacement: `${head}x${tail}${text}${cr}`,
    });
  }
  invariant(
    boxes.length > 0,
    'BAD_ARGUMENT',
    'This Item body has no Done-when checkboxes (`- [ ] …`) to tick. Record the evidence with comment-planning-item, or edit the body with put-planning-item.',
  );
  const listing = () => {
    const open = boxes.filter(candidate => !candidate.done);
    return (open.length ? open : boxes)
      .slice(0, 20)
      .map(candidate => `${candidate.index}. ${candidate.done ? '[x] ' : ''}${clip(candidate.text)}`)
      .join(' | ');
  };
  let matches: typeof boxes;
  if (typeof line === 'number') matches = boxes.filter(candidate => candidate.index === line);
  else {
    const prefix = normal(line).toLowerCase();
    matches = boxes.filter(candidate => candidate.text.toLowerCase().startsWith(prefix));
  }
  if (matches.length !== 1)
    throw new ForgeError(
      'BAD_ARGUMENT',
      `line ${JSON.stringify(line)} matches ${matches.length === 0 ? 'no Done-when checkbox' : `${matches.length} checkboxes`}. ${
        matches.length === 0 ? 'Candidates' : 'Matches'
      }: ${matches.length ? matches.map(m => `${m.index}. ${clip(m.text)}`).join(' | ') : listing()}. Send line as the 1-based position or a longer unique text prefix.`,
    );
  const found = matches[0]!;
  const open = boxes.filter(candidate => !candidate.done).length - (found.done ? 0 : 1);
  if (found.done) return { body, index: found.index, text: found.text, already: true as const, open };
  rows[found.row] = found.replacement;
  return { body: rows.join('\n'), index: found.index, text: found.text, already: false as const, open };
}

export type TickPorts<Item extends { version: number; body: string }> = {
  line: number | string;
  /** The stored Item, read fresh (one workspace query and one detail read). */
  read: () => Promise<Item>;
  /** A versioned body put; a stale version throws ITEM_CHANGED. The key names this attempt's retained operation id. */
  write: (item: Item, body: string, key: string) => Promise<number | undefined>;
  /** The evidence comment, posted once under a retained operation id. */
  comment: () => Promise<Record<string, unknown>>;
};

/** Tick, retrying on a version race by re-reading and re-applying only this tick (other edits stay). The evidence
 * comment follows the tick, so it never names a line that is still open. A line another writer already ticked
 * writes nothing and still gets its evidence. */
export async function tickPlanningLine<Item extends { version: number; body: string }>(
  ports: TickPorts<Item>,
) {
  for (let attempt = 0; ; attempt++) {
    const item = await ports.read();
    const ticked = tickBodyLine(item.body, ports.line);
    let version = item.version;
    let workRevision: number | undefined;
    if (!ticked.already) {
      try {
        workRevision = await ports.write(item, ticked.body, `tick-put-${attempt}`);
        version = item.version + 1;
      } catch (error) {
        if (error instanceof ForgeError && error.code === 'ITEM_CHANGED' && attempt + 1 < maxAttempts)
          continue;
        throw error;
      }
    }
    const comment = await ports.comment();
    return {
      ticked: {
        line: ticked.index,
        text: clip(ticked.text),
        ...(ticked.already ? { alreadyTicked: true } : {}),
      },
      openLines: ticked.open,
      version,
      ...(workRevision === undefined ? {} : { workRevision }),
      comment,
      ...(attempt ? { retries: attempt } : {}),
    };
  }
}
