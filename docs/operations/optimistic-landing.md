# Optimistic landing and recovery

Native owners can opt in with `acceptance.landing: "optimistic"` using
`nforge agent ROOT set-policy '{"operationId":"UUID","acceptance":{"landing":"optimistic"}}'`.
The default is unchanged. Recovery requires trusted acceptance (`auto-on-pass`),
including custom policies with that authority. Supervised projects retain the
fix-forward handoff. Protected paths and allowed actors retain their normal review rules.

Manifest-disjoint candidates run the configured scoped check and land with a
Channel compare-and-swap. Concurrent disjoint main changes use the existing
manifest proof. Overlapping open Lane checkpoints or queued candidates retain
combined landing batches. Dirty, uncheckpointed peer edits are not evidence of
independence. The standard check still runs static verification; custom checks
retain their configured command. Original Lanes and working copies remain open
under this mode, including autonomous projects.

Accepted requests coalesce into a full audit of the newest main. An audit retains its pinned head while later landings request the next one.
Foreground checks can preempt an audit through the existing capacity queue;
the retained cancelled execution gets a new run identity when resumed. A red audit gets one full retry before attribution. A passing retry records
a flaky outcome without reverting source or creating a fix-forward Intent.

Recovery examines landings since the last passing full audit, checking a clean
baseline and recursively checking both halves of the landed set. Exact subset
Views and run identities are reused after interruption or restart. Both halves
are examined to find multiple culprits; changes that fail only together retain
joint attribution. Scoped checks select affected tests through the standard
impact hook, including the failed files identified by pinned remote shard evidence. Commands without usable scope still run their configured checks;
Forge does not invent passing evidence for unexecuted tests.

The reverse deltas compose on current main and receive their own exact check
before ordinary policy-enforced acceptance. This adds a compensating State and
View; main never rewinds. Unrelated later source survives. Culprit Lanes and
Intents reopen with the failed audit evidence in their decision notes, exposed
as notices in their peers digest. Original source and acceptance records remain.
An inconclusive check never proves a culprit. Reverse conflicts, failed recovery
verification, unavailable attribution or changed policy fall back to a fix-forward
Intent. Interrupted checks remain resumable.

Each automatic revert records its audit, culprit landings, acceptance and a
single `nforge agent ROOT undo-revert` command. Substitute the owner path for
`ROOT`. Undo composes the inverse on current main, runs a full check and accepts
under current policy. It retains later changes and reconciles repeated operation
IDs. Failed checks or conflicts retain the undo View for repair and review;
undo does not bypass normal acceptance authority.
