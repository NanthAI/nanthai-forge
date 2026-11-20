// SPDX-License-Identifier: Apache-2.0
import { ConvexError } from 'convex/values';
/**
 * Agents quote ids as 8-character prefixes or full UUIDs. A query that looks like one (8+ hex
 * characters, optional UUID dashes, any case) is returned lowercased; anything else is undefined.
 */
export function idPrefix(text: string): string | undefined {
  const value = text.trim().toLowerCase();
  return /^[0-9a-f]{8}[0-9a-f-]{0,28}$/.test(value) ? value : undefined;
}
export const idMatches = (ids: readonly string[] | undefined, prefix: string | undefined) =>
  !!prefix && !!ids?.some(id => id.toLowerCase().startsWith(prefix));

/**
 * The server resolves an Item by its 8-character prefix or full UUID only (planningIdPrefix in
 * src/planning-search.ts): the search text for that, or undefined when the prefix cannot name one.
 * Longer partial prefixes look up their first 8 characters; the caller filters the result.
 */
export function idLookupText(prefix: string | undefined) {
  if (!prefix) return undefined;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(prefix))
    return prefix.replaceAll('-', ' ');
  return /^[0-9a-f]{8}/.test(prefix) ? prefix.slice(0, 8) : undefined;
}

/** One lookup's answer: the rows every read that succeeded found, and whether a read failed (so the
 * next query may ask again). */
export type Lookup<T> = { rows: T[]; retry: boolean };
/**
 * The reads of one lookup, sent together. A read that fails drops only its own rows: the others still
 * show, and the answer says to retry. A read with nothing to find answers [] itself.
 */
export async function lookupEach<T>(
  reads: readonly (Promise<readonly T[]> | readonly T[])[],
): Promise<Lookup<T>> {
  const settled = await Promise.allSettled(reads);
  return {
    rows: settled.flatMap(read => (read.status === 'fulfilled' ? [...read.value] : [])),
    retry: settled.some(read => read.status === 'rejected'),
  };
}

/** An Item the planning search named by its id (projectHostedPlanningSearch:search, matchedBy 'id'). */
export type IdItem = { id: string; kind?: string; title?: string; status?: string; at?: string };
/** A landing the receipt read returned (projectHostedLandings:read {receiptId}). */
export type IdLanding = {
  receiptId: string;
  title?: string | null;
  laneId?: string | null;
  intentId?: string | null;
  committedAt?: string | null;
  landedHead?: string;
};
/** Only the Items the id named: the text matches the search also returns are someone's mention of it. */
export const itemsById = (raw: string) =>
  ((JSON.parse(raw) as { items?: (IdItem & { matchedBy?: string })[] }).items ?? []).filter(
    item => item.matchedBy === 'id',
  );
/** Codes the receipt read answers for an id that names no single landing: an empty answer, not a retry. */
const noLanding = new Set(['NOT_FOUND', 'AMBIGUOUS_ID', 'BAD_ARGUMENT']);
const code = (error: unknown) => {
  const data = error instanceof ConvexError ? (error.data as unknown) : undefined;
  return data && typeof data === 'object' && 'code' in data ? String(data.code) : '';
};
export const landingsById = (read: Promise<string>) =>
  read.then(
    raw => (JSON.parse(raw) as { landings?: IdLanding[] }).landings ?? [],
    error => {
      if (noLanding.has(code(error))) return [];
      throw error;
    },
  );
/** The receipt read and the Lane resolver take the id with its dashes; a full UUID's server search text has spaces. */
export const idRef = (text: string) => text.replaceAll(' ', '-');

type Timers = { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
/**
 * At most one debounced lookup per id: typing or pasting settles before it runs, a repeated id
 * reuses the answer, and an id already on the page or a non-id query never calls at all.
 */
export class IdLookup<T> {
  private readonly answers = new Map<string, Lookup<T>>();
  private readonly asked = new Set<string>();
  private timer: unknown;
  constructor(
    private readonly run: (text: string) => Promise<Lookup<T>>,
    private readonly changed: () => void,
    private readonly delay = 350,
    private readonly timers: Timers = {
      set: (run, ms) => setTimeout(run, ms),
      clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  ) {}
  private answer(prefix: string | undefined) {
    const text = idLookupText(prefix);
    // A full UUID typed after its 8-character prefix reuses that answer (it lists every match, up to 5).
    return text ? (this.answers.get(text) ?? this.answers.get(text.slice(0, 8))) : undefined;
  }
  /** The answer for this query's lookup text, once it has arrived. */
  found(prefix: string | undefined) {
    return this.answer(prefix)?.rows;
  }
  /** This id query has no answer yet (its lookup is about to run or on its way): "nothing matches" would be premature. */
  pending(prefix: string | undefined) {
    return !!idLookupText(prefix) && !this.answer(prefix);
  }
  /** Every read of this query's lookup failed: nothing to show, and the next query may retry. */
  failed(prefix: string | undefined) {
    const answer = this.answer(prefix);
    return !!answer?.retry && !answer.rows.length;
  }
  want(prefix: string | undefined, onPage: boolean) {
    this.timers.clear(this.timer);
    const text = onPage ? undefined : idLookupText(prefix);
    if (!text || this.asked.has(text) || this.asked.has(text.slice(0, 8))) return;
    this.timer = this.timers.set(() => {
      this.asked.add(text);
      const settle = (answer: Lookup<T>) => {
        this.answers.set(text, answer);
        // A read that failed may be retried by the next query; what the others found still shows.
        if (answer.retry) this.asked.delete(text);
        this.changed();
      };
      this.run(text).then(settle, () => settle({ rows: [], retry: true }));
    }, this.delay);
  }
  cancel() {
    this.timers.clear(this.timer);
  }
}
