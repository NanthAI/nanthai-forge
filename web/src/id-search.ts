// SPDX-License-Identifier: Apache-2.0
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

type Timers = { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
/**
 * At most one debounced lookup per id: typing or pasting settles before it runs, a repeated id
 * reuses the answer, and an id already on the page or a non-id query never calls at all.
 */
export class IdLookup<T> {
  private readonly answers = new Map<string, T[]>();
  private readonly asked = new Set<string>();
  private timer: unknown;
  constructor(
    private readonly run: (text: string) => Promise<T[]>,
    private readonly changed: () => void,
    private readonly delay = 350,
    private readonly timers: Timers = {
      set: (run, ms) => setTimeout(run, ms),
      clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  ) {}
  /** The answer for this query's lookup text, once it has arrived. */
  found(prefix: string | undefined) {
    const text = idLookupText(prefix);
    // A full UUID typed after its 8-character prefix reuses that answer (it lists every match, up to 5).
    return text ? (this.answers.get(text) ?? this.answers.get(text.slice(0, 8))) : undefined;
  }
  want(prefix: string | undefined, onPage: boolean) {
    this.timers.clear(this.timer);
    const text = onPage ? undefined : idLookupText(prefix);
    if (!text || this.asked.has(text) || this.asked.has(text.slice(0, 8))) return;
    this.timer = this.timers.set(() => {
      this.asked.add(text);
      this.run(text).then(
        rows => {
          this.answers.set(text, rows);
          this.changed();
        },
        // A failed lookup may be retried by the next query; the page's own matches still show.
        () => this.asked.delete(text),
      );
    }, this.delay);
  }
  cancel() {
    this.timers.clear(this.timer);
  }
}
