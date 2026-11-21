- The top bar's main segment reads `main · N today · X% first try` (on a phone `main · N · X%`): landings on
  main in the UTC day and the share that landed on their [first try](../../concepts.md#core-model), from the
  line feed's Flow day. The landing judges itself on the summary write it already made; an idle tab reads
  nothing. `nforge status` returns the same figure as `mainToday`, and `flow` adds it to main's line.
  Stats names the latest measured day and when figures update. When its period includes today, it shows today's
  figures from the same feed when available.
