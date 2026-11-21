// SPDX-License-Identifier: Apache-2.0
const clocks = new WeakMap();

/** Start on a fixed UTC day with ISO stamps and scheduler time on the same clock.
 * `{ elapsed: true }` also freezes `performance.now`, so measured durations written to rows (the
 * source step's `timing.steps[].callMs`) cannot add a digit run to run: exact bytes for replays that
 * run source steps (incident 70a9bd2f, keep-the-run line 3). */
export function storageClock(t, { elapsed = false } = {}) {
  let clock = clocks.get(t);
  if (!clock) {
    const OriginalDate = Date;
    class FixtureDate extends OriginalDate {
      constructor(...args) {
        if (args.length) super(...args);
        else super(FixtureDate.now());
      }
      static now() {
        return OriginalDate.UTC(2026, 10, 10, 12);
      }
    }
    globalThis.Date = FixtureDate;
    clock = { elapsed: false };
    clocks.set(t, clock);
    t.after(() => {
      globalThis.Date = OriginalDate;
      if (clock.elapsed) delete performance.now;
    });
  }
  if (elapsed && !clock.elapsed) {
    clock.elapsed = true;
    const started = performance.now();
    Object.defineProperty(performance, 'now', { configurable: true, writable: true, value: () => started });
  }
}
