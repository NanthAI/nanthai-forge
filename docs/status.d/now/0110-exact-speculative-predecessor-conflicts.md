Exact speculative-predecessor conflicts expose pinned early sync/resolve recovery.
Save-time exact peer notices offer that sync as soon as the peer has a fixed check;
resolved peer deltas no longer create false notices, and acceptance clears old notices.
An internal cohort conflict names the checked survivor prefix containing the
conflicting peer; an outer-base conflict keeps its exact outer predecessor.
Early resolution is on unless `acceptance.earlyResolve` is `"off"`; legacy
Automatic/on values remain readable. No sample window or rate decision is maintained.
Resolved work checks on the fixed train tail, preserving its check across later
mergeable groups; a clean pinned sync changes no Lane or landing. Lineage
supersession covers conflicting own-main sync, source preparation, ownerless
retry and resolution completion. Composing cohorts recover within the existing
five-minute train hold and retain lost-owner diagnostics. A retry or split replaces
the retired compose timer immediately, including the solo source backoff after
a singleton split; a retired cohort's late compose callback
cannot replace its successor's finish wake. Finish timer retirement cancels only
pending tasks: running actions drain under their existing IO fences, preserving
their later source dispatch and recovery wakes. The reproduced finish-owner loss in
`c01d5457` is fixed and live-qualified; its unexplained historical 605 s source
action remains on Phase 7 `e3082c24`. One attempt allocator
refreshes reserved finish ordinals at installation, guarded by foundation checks.
A failed,
withdrawn or changed predecessor restores author source and retires its check.
The synthetic trio improves 615 to 360 seconds with three checks in both paths;
a later overlapping group improves 540 to 360 seconds with one accepted child
check. The retained incident replay terminalizes every operation with zero idle
tasks and at most one live submission per lineage after every transition.
Reader-first rollout, live timing and billed qualification remain separate
([early resolution](../../pre-queue-checks.md#resolve-an-exact-predecessor-conflict-early)).
