- `nforge agent ROOT flow` draws the project's work as text from the top bar's line feed: one line per
  stop with open and held Lanes (by id), the longest wait and the Lanes checked together, then main's
  landings today, the ways back (needs fix, reverted, fixed on top), CI minutes and the next step. The
  line feed now carries the Flow view's day (landings per hour, land-to-main times, needs fix, reverted,
  main passing or failing since) in the writes it already made ([architecture](../../architecture.md#live-lane-line)).
