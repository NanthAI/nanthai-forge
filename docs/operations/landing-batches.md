# Local landing batches

Native `finish` operations with an explicitly configured check runner queue code
candidates in Work format 17. `land-ready` resumes incomplete batches as well as
dependency waits. Legacy projects without a runner policy retain their existing
finish protocol. Git, protected paths, supervised review, invariant-pinned
acceptance and docs-only candidates retain the ordinary finish path. Applicable
passing evidence can still use the disjoint fast lane, which checks queued paths
as well as changes on main before overtaking.

A drain selects up to four ready candidates (eight on a remote runner) with compatible
check, runtime and lifecycle pins. A local runner never waits for a batch to fill. Entries are
ordered by `finish` priority (`urgent`, then `normal`) and original arrival. After
two entries from one submitter, later entries yield one position per round to
other submitters in that priority class. This changes order without imposing a
quota. Requeued entries retain their arrival timestamps.

The batch retains its base, ordered entries, cumulative prefix Views, conflict
Views, deterministic run IDs, attribution and acceptance receipt. Source pins
are immutable even if an input Lane advances. A composition conflict ejects that
entry and composition continues. Checks run outside Work, Lane and landing
locks. The selector receives the union of candidate changed paths, so tooling
changes retain the full-check override.

## Remote bursts

Modal and GitHub Actions checks do not share the owner's CPU, so a burst need not queue
behind one check. Before the first check of an idle channel, the drain waits until
`acceptance.batchWindowMs` (default 2000) after the oldest queued entry, or until a
batch is full. Entries arriving while a check runs form a speculative batch stacked on
the newest active one: its base is that batch's final prefix, so its exact-head check
covers main as it will be once the parent lands. Up to `checks.concurrency` batches
(default 4) are checked at once. A stacked batch accepts only after its parent
finished and only if main equals its recorded `previous`; its failure verdict is
trusted only then. If the parent landed a shorter prefix, failed or was cancelled, the
stacked batch is superseded and its entries requeue at their original age for a check
on real main. A restarted driver adopts every recorded batch in order. Local runners
never stack or wait.

A passing batch moves main once, with every included Lane head recorded in its
View. A remote failure (Modal or GitHub Actions) checks all proper prefixes in one parallel round, lands
the longest passing prefix, and attributes the next entry to its exact failed
run. The remaining entries requeue. Local runners halve the prefix interval
instead, only accepting a prefix that passed its own exact-View check. Interrupted
or cancelled checks remain distinct from failed checks. `cancel` also accepts a
queued entry operation ID: it ejects that entry, checks and lands only the prefix
before it, and requeues the later entries. Already accepted work is retained.

If main advances while checking, acceptance uses the existing manifest-disjoint
proof when available. Otherwise it retains the old attempt and requeues on the
new main. A restarted driver adopts persisted Views, runs and acceptance IDs;
a lost acceptance reply never causes another Channel move.

Every batch acceptance requests the existing coalesced full-main audit, including
when the landing check was full. Audit failure creates the existing fix-forward
Intent without rolling back main by default. Opt-in [optimistic landing](optimistic-landing.md)
can compensate attributed failures under trusted policy. Modal audits use a separate capacity queue so
audit execution cannot occupy a landing-check slot. Audits do not block the
acceptance response. Modal budget enforcement is separate from batching.

Format 17 adds `landingEntries` and `landingBatches`; it does not activate the
historical unified Intent format 16. Format 18 composes unified Intents and
batching; explicit Intent migration converts formats 15, 16 and 17 to 18. Batch
writes preserve format 18. Writers must support the owner’s current format. Original source, checks, conflicts and acceptance history remain
retained. Undo accepted work through a checked compensating change.
