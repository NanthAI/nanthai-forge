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
native `disjointFastPath` setting. Under S2-reuse, the landing uses either the
exact passing Candidate or a clean recomposition of the same pinned inputs
onto current main. For recomposition, the reuse proof must show either that
main's changes are outside the original check's inputs under the conservative
impact rules, or that the entire file tree from a full passing check is
unchanged. The original run still names the source it checked.
A strict GitHub merge queue requires the checks to pass on the current merge group
including the latest base and work ahead in the queue. See
[hosted check reuse](../../../architecture.md#hosted-check-reuse-across-main-moves).

The conservative first-check rule (`clean-disjoint-v2`) compares four verified
manifests: checked base, checked head, current main and recomposed head. The
recomposition must preserve both deltas, including modes and deletions. Paths
must be disjoint, including file/directory prefixes, apart from verified
identical entries and clean merges of Markdown that no test or script reads.
Shared check inputs and unplaceable global risk still prevent reuse, and a
changed symlink or submodule requires another check. The run must cover the full
check or the docs selection for a docs-only change, with a green full main audit
baseline and no debt. The proof reads manifests and pinned selection evidence.
The prompt main audit covers semantic interactions the proof can miss and can
trigger a single-culprit revert or a fix forward. See the
[hosted acceptance gate](../../../workflows.md#hosted-acceptance-gate).
Any doubt retains the ordinary exact recheck and records the reason on the
receipt (`firstCheck`). A newer main race repeats the proof against the original
checked head, without constructing a chain of inherited passes. Batches retain
one shared exact recheck: their multiple same-head receipt snapshots do not yet
provide the single-transition recovery proof required for this optimization.

The checked run's pinned package graph can place a manifest or lockfile's risk
in that package and its dependents
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
