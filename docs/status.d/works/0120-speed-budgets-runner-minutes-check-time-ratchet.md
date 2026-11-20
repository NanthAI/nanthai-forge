- Speed budgets judge runner minutes per full check beside wall time (saying "not
  enough data" when too few full checks fill the window), name a landing whose new
  test files add runner seconds on every check in its receipt and land reply
  (`checkTime`, net of renamed or deleted tests, never a block), and ratchet a
  percentile line down after seven closed days under it; a window over a ratcheted
  line undoes it with a message, never a P0, and `nforge metrics` shows the
  automatic line beside the file line
  ([speed budgets](../../agents/speed-budgets.md#ratchet)).
- Failed admission checks retain reported runner seconds, and the waste meter
  includes those runs in check-failure waste ([metrics](../../operations.md)).
