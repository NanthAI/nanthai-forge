Canonical Candidate file readers negotiate `candidate-source-files`. Their
source-only R2 listing pins the exact base
and head and contains changed paths, modes and blob identities, with no people
or Work payloads. Candidates composed before listings existed still open through
the two exact State manifests; CLI provenance retains its canonical history
reader. All compose producers (public, finish, batch, GitHub inbound and culprit)
write the listing unconditionally, with no environment setting.
Small, stepped and fixed workers build one
listing from their already verified manifests; publication pins its digest/size
as server metadata on the immutable Candidate, with no new landing RPC. Old
indexed readers of a Candidate carrying that pointer return `CLI_UPGRADE_REQUIRED`.
Compatible canonical Candidate header reads keep their original shape.

The unconditional-listing fixture budgets (Issue `91df7eda`) account for one
R2 object and its descriptor: the dogfood recompose retains 109 B more Candidate
metadata and 424 B more `projectObjects` JSON. Existing R2 counters add 1 B each
to the source step, landing request, finish-read header and speed row, and 7 B to immediate landing
observations; no new Convex call or per-file row is needed. The 29k/58k ancestry
fixture accounts for two descriptor reads and one descriptor write per listing
inside its existing source calls; its history-growth and memory bounds remain.
The batch fallback guard keeps its controller write bound and separately allows
at most one descriptor mark per distinct new listing pin in existing calls.
The six-landing mix
adds exactly four PUTs and four GET/HEADs; the inbound fixture adds one of each
and 631 uploaded bytes. These are synthetic deltas, not billed usage. The cost
ledger retains a Class B warning for a pre-existing 0.83 request difference
between its old budget and the current baseline, separately from the approved
0.67 listing requests per landing.

Legacy projection writers remain unchanged. Existing `projectWorkDataRecords`
rows are unchanged; no migration or deletion runs implicitly. See the [replacement and migration plan](../../research/placement-review.md#s4-per-file-projections-leave-convex).
Those writers stay in Convex by design: the [S4 remaining-writers verdict](../../research/placement-review.md#s4-remaining-writers)
sizes each one and proposes a single change, onboarding without per-file rows.

The policy-history index on project and the previous mirror's enabled flag selects
one recorded direction for pre-Pause disabled mirrors. It adds one index entry per
policy-change row; no new table, source bytes, landing write or idle function.
Explicit Resume selects current main and its acceptance metadata, then reuses the
existing mirror job queue. One selected latest job under the existing receipt
index is compared with the current repository (case-insensitively), so a completed
publish to an old repository cannot suppress catch-up to a new one. No mirror-job
index entry or key bytes are added. The paused window becomes one catch-up
commit, not one job per paused landing. Its first seed reads the mapping's receipt
and at most 21 acceptance rows by sequence to list the first 20 subjects and a
remainder count, then pins that message. Adjacent publishes add zero history
reads; replays read the pinned seed instead of rebuilding its message.
