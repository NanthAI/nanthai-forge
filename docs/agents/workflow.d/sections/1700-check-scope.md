## Check scope

Scoped selection ships OFF; after installing the updated runner, with post-accept full main checks active and all writers supporting Work format 13, enable
with `FORGE_CHECK_SCOPED=1` in the runner environment. The standard `verify` check records `checkSelection.scope` (`docs`, `scoped`, or
`full`), the selection reason and exact test-file list. Scoped checks retain all
static checks and select transitive test importers plus smoke coverage. Set
`FORGE_CHECK_FULL=1` before `run` or `finish` to force full verification; the input
is captured in the environment fingerprint. Missing runner comparison inputs
fall back to full. Pinned main-audit Candidates (`mainCheck.channel`) always run full, including manual reruns without an environment override. See [development](../../../development.md#scope-aware-standard-check).

A shared batch fallback preserves an already-reserved individual check when its
Candidate, input/dependency roots, authority and run pins still match. It repairs
legacy scheduling flags without changing that attempt or starting another run;
a later pass on the original run can accept on unchanged main. A genuinely shared
check still needs an individual composition after fallback. Attempt history names
that transition `BATCH_FALLBACK`; only an actual main head or receipt advance is
`CHANNEL_CHANGED`. A check-binding change is `ATTEMPT_REPLACED`, and an audit
proof refresh without source churn is `CHECK_EVIDENCE_REFRESH`.

`acceptance.landingMode` (absent is `strict`; `fast` while main is green, the audit is fresh and the 50-outcome circuit breaker is clear) decides
which refused proofs still land on the Lane's own check: [landing modes](../../../pre-queue-checks.md#landing-modes).
Hosted main-only finish retries can reuse a READY pass through
`acceptance.hostedCrossHeadReuse` (absent means on). This is separate from the
native `disjointFastPath` setting. Single-Candidate owner-agent automatic landings recompose their
pinned inputs cleanly on current main. They land on their first check (rule
`clean-disjoint-v1`, Issue 7fe54c7c) when the four verified manifests (checked
base, checked head, current main, recomposed head) show: the recomposition is
exactly the union of both deltas (modes and deletions included); the changed
paths of the two deltas are disjoint, including file/directory prefixes; neither
side touches a [global-risk file](../../../pre-queue-checks.md#global-risk-files); no
changed path is a symlink or submodule on any side (untouched links do not count); the
first run's own selection was the full check (or docs for a docs-only change);
and main is green with a full audit baseline and no audit debt. It reads six
small objects and no source text or import graph, so a path-disjoint semantic
break (change 556) can reach main: the main audit, armed at once for these
landings, catches it and recovery reverts a single proven culprit or fixes
forward (see [hosted acceptance gate](../../../workflows.md#hosted-acceptance-gate)).
Any doubt retains the ordinary exact recheck and records the reason on the
receipt (`firstCheck`). A newer main race repeats the proof against the original
checked head, without constructing a chain of inherited passes. Batches retain
one shared exact recheck: their multiple same-head receipt snapshots do not yet
provide the single-transition recovery proof required for this optimization.

From risk rule v3 a manifest or lockfile inside a package is risk only for that package
and its dependents, using the package graph the checked run pinned
([placed manifests](../../../pre-queue-checks.md#global-risk-files)).

When the proof is refused, an automatic-acceptance project's retry runs a scoped
recheck instead of the full suite, under the contract gate, the full gate or no gate
(receipt `landedOn: "scoped-intersection"`). A cohort recheck runs the union of its
members' intersections when every member holds a full-pass basis: see
[hosted acceptance gate](../../../workflows.md#hosted-acceptance-gate).

Proof analysis holds one renewable owner lease on the existing finish watchdog.
Duplicate delivery starts no second analysis, cancellation fences late callbacks,
and an expired proof falls back once to its named exact retry.

The receipt records `crossHeadProof`: both source heads, both changed-path
lists, the risk rule, the immutable check/selection digests and a comparable
full-passing main baseline (older receipts carry the earlier
`conservative-impact-v1` test proofs).
A legacy full main receipt can seed that baseline only after its exact passing
run and full selection are verified. The recomposed head adds main-audit debt;
it never adopts the old pass as a full audit of new bytes. Existing coalesced
main auditing and culprit classification, fix-forward or compensating revert
handle a failed audit. Authority, policy, source registration, governance, input
pins and current main/receipt CAS are still checked at publication. Set
`acceptance.hostedCrossHeadReuse:false` to retain ordinary exact retries.

Hosted `prioritize` accepts queued, checking and ready submissions with the
existing owner authority and priority-version CAS. It changes one submission row
and preserves its check, attempt and live lease. Urgent READY work takes the next
free acceptance lease ahead of normal READY work; an existing live lease and a
reserved shared batch check continue unchanged. Settled submissions retain their
recorded priority. Use another priority change with the current version to undo.
