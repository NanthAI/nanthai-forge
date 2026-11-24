### Hosted overlap advice

Hosted agent start, save and Lane status responses include
`behindMain:{commits,conflictingPaths,more,coverage}` when the server advertises
`overlapVersion:1`. `behindMain.nudge` (one line) appears only when at least 2 distinct landings touched your saved paths since your base: it names up to 3 (receipt, Lane, public actor) and the exact `sync` command; absent otherwise, so the answer is unchanged. It reads the path history `behindMain` already loads, with each landing's name on its per-landing row (a Lane further behind than those rows reads up to 3 names by key), with no extra call (a count of distinct landings by latest touch per path, so a floor). `peers` evidence names the peer
Lane, actor, Intent and shared saved path, with `class:"blocking"|"advisory"` and a `reason`. Saving, checking and landing never wait on it: path overlap notices and their answers were removed (Issue 853fcde3), and a real conflict comes back as `conflictNotice` ([exact conflicts at save](#exact-conflicts-at-save));
no polling, subscriptions or idle work are added.

Save staging retains a bounded path projection and publishes it with the Lane
head. Replaying identical evidence does not rewrite the path buckets or Lane
projection. A change to the Lane record version, activity, lifecycle or pending
save evidence can still update the projection at the same head. Blocking means
intersecting or immediately adjacent line ranges with a
shared exact base, distinct additions at the same path, or delete/rename versus
another change. Symbol names alone do not block. Identical resulting bytes/modes
and two deletions are clean. Disjoint saved changes produce no automatic notice;
explicit `peers {path}` still shows saved-path activity. Missing, stale or differently
based range evidence retains an advisory with incomplete coverage.
Composition still checks the exact Candidate and retains true conflicts through
the existing resolution path. Resolution projections retain the exact left source:
the origin at that source and sibling resolutions of it are excluded within the
same Intent. A peer's later saved work remains eligible.

Path identities are selected before range metadata within the existing
128 KiB projection budget, so a large early source file cannot hide later test
paths. When the budget overflows, unused declaration names are omitted so useful ranges
fit. Full metadata is kept while it fits, including across successive saves.
The original full-metadata budget still marks coverage incomplete when it would
overflow, preserving unavailable preflight behavior while retaining later paths
and ranges for advice. Omitted range metadata also remains incomplete.

Compact local line hashes and declaration summaries come from the checkout's
existing verification stream and capture's already-read bytes. Saves reuse the
original base summary across successive edits and carry ranges on their existing
metadata pages, with no new full-file reads or Convex calls. Older clients without
summaries still save normally. `overlapEvidenceVersion:1` is negotiated through
the existing capability read; clients omit range metadata for older strict save
APIs, without an extra per-save probe. Reverting a file to its saved base clears its projected change. Main
acceptance updates the latest accepted sequence touching each retained path, so
status compares against the Lane base without walking acceptance history. The same
write logs each landing's touched paths on a small row, keeping the newest 64; a save,
sync, resolve or status of a Lane at most 64 landings behind reads only the rows after
its base, and only a Lane further behind (or a landing with too many paths for a row)
reads the whole compact history, up to 128 KB.
`conflictingPaths` predicts shared files, not a proven text merge conflict.
Five peer evidence items and ten main paths are shown per response. Metadata windows,
older source without a projection, syncs without path evidence and unknown base
sequences report incomplete coverage; a missing notice never proves independence.
Unavailable advice retains the source receipt with explicit unknown coverage.
Older clients and servers keep their existing protocol through capability
negotiation. Needs you continues using its existing work projection. Server behaviour a
new CLI relies on is a named contract feature on that same capability read; a CLI never
assumes one its server has not advertised ([CLI update: server contract](../../../operations/cli-update.md#server-contract-cli-ahead-of-the-deploy)).
