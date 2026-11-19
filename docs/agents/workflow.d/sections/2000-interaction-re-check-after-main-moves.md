### Interaction re-check after main moves

When a native `finish` check passes and main advances, the disjoint fast path
continues to require exact immutable manifest independence. Graph edges select
behavior tests only. After refusal, finish pins the passing run, its composed
main M0, its checked candidate and the next main M1 before syncing. Lost replies
replay those pins; another main movement creates a separately pinned attempt.
Acceptance still requires a passing check on the exact merged Candidate and the
ordinary current-main compare-and-swap.

Each replacement attempt prints one `finish retry` progress line with short old/new
main pins, up to ten overlapping paths and their total count, the fast-path
rejection reason and the replacement run ID. Progress `elapsed` measures the current
phase; `totalAge` separately measures the operation's age.

Before machine-queue admission, native standard-check interaction retries use
the installed test-impact selector against immutable merged source. Eligible docs
overlap with both sides classified as non-full runs the merged docs/static checks
without taking a heavyweight check slot. Code overlap, unknown inputs, unavailable
classification, scoped mode OFF and explicit full retain ordinary admission. The
check's exact-Candidate evidence and atomic current-main validation are unchanged.

With `FORGE_CHECK_SCOPED=1`, a Markdown-only overlap (clean, or resolved as above) selects `docs`
after validating the reused passing run, composition, ancestry and applicability,
and classifying both complete path sets as non-full. This basis needs no full
main coverage and runs all merged static checks with zero behavior files.
Code interaction requires an exact passing full run on pinned main and selects
the intersection of both impacted test sets, plus overlapping-path tests and
fixed smoke. Valid but ineligible evidence uses ordinary selection for the merged
Candidate's comparison paths, recording the ineligibility reason. Missing or malformed
pins still require full. Scoped OFF, explicit full and pinned main audits require
full; ordinary path classification can also require full.
See [interaction selection](../../../development.md#interaction-selection-and-retained-evidence)
for the runner validation and execution contract.

Work format 15 retains version-1 runner-derived evidence separately from the
command-reported scope, reason and exact sorted test list: the reused run, M0,
checked candidate, M1, merged head, both path sets, overlap, optional main coverage run, basis (`docs-overlap` or
`main-full-coverage`) and eligibility/fallback reason. Portable exports and imports retain it; format-14
writers reject the new format before writing. Docs and interaction acceptances
still request full post-accept main verification and the existing fix-forward
handoff on failure.

For an offline Git import through first supervised acceptance, run `nforge docs quickstart`.
`nforge docs agent` prints the packaged agent skill. Start records `actor` (or
`FORGE_AGENT_NAME`, then `FORGE_ACTOR`); use distinct names for concurrent agents.
