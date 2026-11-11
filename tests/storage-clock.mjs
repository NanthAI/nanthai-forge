// SPDX-License-Identifier: Apache-2.0
/** Keep ISO stamps and scheduler time on the same clock for exact document-byte ratchets. */
export function storageClock(t) {
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
  t.after(() => {
    globalThis.Date = OriginalDate;
  });
}
