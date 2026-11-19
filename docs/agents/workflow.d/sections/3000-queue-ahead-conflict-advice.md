## Queue-ahead conflict advice

Pending hosted receipts include `queue` with position, total entries, entries ahead,
the live predecessor and an approximate group-aware ETA. `observe`, `status` and
`landing` return current canonical server state without computing source advice.
They include `queueAhead` only when advice is already cached for the exact current
authorized pins; a cache miss reports `queueAheadUnavailable`. The preview says **“if entry X / Lane
Y lands, paths conflict”**. It is advisory: it never rejects, delays or reorders
submission. A checking entry or one whose check passed is `actionable`; a merely
queued entry is `fyi`. Clean pairs produce no conflict advice. Unavailable source
is reported separately and never treated as a clean merge.

The preview uses immutable submitted Candidate heads against current main, rather
than later Lane edits. It considers at most eight earlier pending entries, with
at most sixteen logical source compositions during an explicit preview. Finite hosted reads perform zero compositions. Exact
(main, submitted head, earlier head) results are reused; `cost` reports composition
calls, cache hits and elapsed milliseconds. Hosted cold source can require lazy
object-resolution retries, reported as `objectResolutions`. Repository checks and
project code do not run. `more` identifies an incomplete queue horizon.
Native previews read selected queue, Channel, Candidate and run records. If
selected record access is unavailable, the preview reports unavailable advice
without loading the complete Work history or delaying the submission.

Advice is joined with current queue state. A failure, conflict ejection or
cancellation removes that entry immediately from subsequent reads; acceptance
moves the ordinary main comparison forward. Hosted status queries depend on the
indexed pending ranges, so those terminal transactions invalidate subscribers.
There is no preview poller, timer, scheduled job or idle computation.

Actionable advice includes an exact `next.shell` command using `start` with
`stackOn` and `stackEntry`. This creates a new child workspace on the parent's
saved source; reapply the intended child changes there. The existing workspace is
preserved. This action does not sync an independent Lane onto unlanded source.
After the parent fails, the child's next `sync` reapplies only its own delta onto
real main; overlapping child changes retain the ordinary conflict resolution.
An explicit `sync` with `ontoMain:true` also detaches a stack. No background
operation rewrites dirty workspaces. These commands work with native authority,
bound native caches and hosted agent addressing.

Native `landing` results also include `firstAttemptLandRate` for the last seven
days. The existing `metrics` read exposes the same calculation over its selected
window for native and hosted records. The denominator is Lanes whose first-ever
land entry was submitted in `[from,to)`; the numerator is those whose first entry
was accepted. Pending first entries remain in the denominator and are counted
separately. Earlier history is retained when choosing the first entry. The metric
reports retried Lanes and preceding retry causes: conflict, check failure/flake,
stall, cancelled and other. It does not infer that a failed check was a flake.
Internal hosted child attempts remain part of their original land entry. All
calculation is read-time work over landing records, with no new background job.
