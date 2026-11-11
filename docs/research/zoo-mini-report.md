# Zoo conformance report

Issue `70a9bd2f-f741-4d26-8ae5-7bb11148a17c` tracks this dev-only run. 26/26 rows have observed results; 26 pass their required paths. The full-suite timing bar remains 1.5× the unchanged baseline. Expected hazard refusals are listed by phase and code. This report supersedes the earlier mini-run narrative; historical results remain in source history.

The harness is [scripts/bench-zoo](../../scripts/bench-zoo/suite.mjs). Fixtures are public upstream forks or synthetic recipes from [catalog.json](../../scripts/bench-zoo/catalog.json). Source bytes go to R2; the DB meter covers metadata I/O, calls, egress and action compute. It does not measure R2 storage/requests. Checks use free GitHub-hosted runners.

26 of 26 repositories pass every path. ✓ pass, ✗ fail, ⊘ refused by name (expected for a hazard), · not reached.

| Repo | import | clone | fidelity | save | sync | land | landReuse | conflict | resolve |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| go | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| python | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| rust | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| jvm | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| mixed | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| csharp | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| electron | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| elixir | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ruby | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| php | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| swift | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| android | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| dart | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| flutter | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| cpp | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| zig | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| npmws | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| lfs | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| history | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| binaries | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| shapes-posix | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| shapes-bigbin | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| shapes-case | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| shapes-collide | ✓ | ⊘ | · | · | · | · | · | · | · |
| shapes-nonutf8 | ⊘ | · | · | · | · | · | · | · | · |
| shapes-unicode | ✓ | ⊘ | · | · | · | · | · | · | · |

## Seconds next to plain git (median over repositories that ran both)

| Operation | Forge s | git s | Forge ÷ git | repos |
| --- | --- | --- | --- | --- |
| import | 21.8 | 1 | 18 | 26 |
| clone | 0.8 | 1 | 0.8 | 25 |
| start | 1.7 | – | – | 23 |
| save | 2.7 | 1.8 | 1.6 | 23 |
| sync | 4.9 | 0.6 | 7.6 | 23 |
| conflict | 12.3 | 0.6 | 19.9 | 23 |
| resolve | 83.6 | 1.7 | 51.3 | 23 |
| land | 82.1 | 1.8 | 44.4 | 23 |
| landReuse | 117.6 | 2.2 | 54.4 | 23 |

The [sync/resolve decomposition](sync-resolve-costs.md) separates local source jobs
and client apply from the checked landing. The `resolve` row above includes that
landing; it is not source-only resolution latency. The next zoo comparison is still
unrun and the decomposition makes no hosted speedup claim.

## Concurrent landing order

`land` times Lane A; the legacy `landReuse` key times Lane C. Either can land first. An overtaken Lane has `mainMoved: true`; the check outcome below distinguishes reuse from rechecking. Timing thresholds remain unchanged.

| Repo | Lane | Overtaken | Check outcome | Reason | Recompositions |
| --- | --- | --- | --- | --- | --- |
| rust | a | no | admission-run | – | 0 |
| rust | c | yes | recheck | global-risk | 1 |
| jvm | c | no | admission-run | – | 0 |
| jvm | a | yes | admission-run | – | 1 |
| mixed | a | no | admission-run | – | 0 |
| mixed | c | yes | recheck | global-risk | 1 |
| csharp | c | no | admission-run | – | 0 |
| csharp | a | yes | admission-run | – | 1 |
| electron | a | no | admission-run | – | 0 |
| electron | c | yes | recheck | global-risk | 1 |
| elixir | a | no | admission-run | – | 0 |
| elixir | c | yes | admission-run | – | 1 |
| ruby | a | no | admission-run | – | 0 |
| ruby | c | yes | admission-run | – | 1 |
| php | a | no | admission-run | – | 0 |
| php | c | yes | admission-run | – | 1 |
| swift | a | no | admission-run | – | 0 |
| swift | c | yes | recheck | global-risk | 1 |
| android | c | no | admission-run | – | 0 |
| android | a | yes | admission-run | – | 1 |
| dart | c | no | admission-run | – | 0 |
| dart | a | yes | admission-run | – | 1 |
| flutter | a | no | admission-run | – | 0 |
| flutter | c | yes | admission-run | – | 1 |
| cpp | a | no | admission-run | – | 0 |
| cpp | c | yes | admission-run | – | 1 |
| zig | a | no | admission-run | – | 0 |
| zig | c | yes | recheck | global-risk | 1 |
| npmws | a | no | admission-run | – | 0 |
| npmws | c | yes | admission-run | – | 1 |
| lfs | a | no | admission-run | – | 0 |
| lfs | c | yes | admission-run | – | 1 |
| history | a | no | admission-run | – | 0 |
| history | c | yes | recheck | global-risk | 1 |
| binaries | a | no | admission-run | – | 0 |
| binaries | c | yes | recheck | global-risk | 1 |
| shapes-posix | a | no | admission-run | – | 0 |
| shapes-posix | c | yes | admission-run | – | 1 |
| shapes-bigbin | a | no | admission-run | – | 0 |
| shapes-bigbin | c | yes | admission-run | – | 1 |
| shapes-case | c | no | admission-run | – | 0 |
| shapes-case | a | yes | admission-run | – | 1 |

## Result-to-commit gap and workspace prep (seconds)

Gap from a check's end to its commit on main: median 3.2, worst 14.8 over 63 landings.

| Repo | start | clone | hosted job overhead | gap (median) |
| --- | --- | --- | --- | --- |
| go | 2.7 | 1.3 | – | – |
| python | 2.9 | 2.2 | – | – |
| rust | 2 | 0.8 | 15.8 | 3.2 |
| jvm | 2.1 | 0.8 | 0 | 3.3 |
| mixed | 2.9 | 1 | 0 | 3.2 |
| csharp | 2.9 | 1.1 | 26.3 | 3.3 |
| electron | 1.8 | 0.6 | 11.8 | 3.2 |
| elixir | 1.6 | 0.8 | 22.7 | 3.8 |
| ruby | 1.4 | 0.7 | 9.8 | 3.3 |
| php | 1.6 | 0.7 | 20.6 | 3.1 |
| swift | 1.7 | 0.7 | 0 | 3.1 |
| android | 1.7 | 0.8 | 0 | 3.1 |
| dart | 1.5 | 0.7 | 24.7 | 3.2 |
| flutter | 1.6 | 0.8 | 24.3 | 3.5 |
| cpp | 1.6 | 0.8 | 0 | 4.5 |
| zig | 1.7 | 0.6 | 0 | 3.1 |
| npmws | 2.3 | 0.6 | 19.9 | 3.2 |
| lfs | 1.5 | 0.8 | 31.2 | 3.2 |
| history | 7.5 | 0.8 | 18.7 | 3.3 |
| binaries | 4.9 | 1.5 | 25.6 | 3.1 |
| shapes-posix | 1.5 | 0.6 | 22.2 | 4.1 |
| shapes-bigbin | 1.9 | 0.9 | 32.5 | 3.5 |
| shapes-case | 1.7 | 0.7 | 21.5 | 3.4 |
| shapes-collide | – | 1 | – | – |
| shapes-nonutf8 | – | – | – | – |
| shapes-unicode | – | 1 | – | – |

Metered row-window Convex subtotal: $0.102 over 21 metered repositories.
Separately prepared imports, owner-wide queries and teardown can fall outside these row windows; report their usage separately.

## Import setup voids

Import seconds above include provider waits and failed setup attempts; successful-attempt seconds remain in RESULT.json.

| Repo | Refusal | Failed attempt s | Provider wait s | Full import wall s |
| --- | --- | --- | --- | --- |
| jvm | GITHUB_RATE_LIMIT | 15.2 | 273.3 | 294.7 |
| mixed | GITHUB_RATE_LIMIT | 1.2 | 2020.7 | 2042.6 |
| csharp | GITHUB_RATE_LIMIT | 5.3 | 2016.6 | 2041.8 |
| electron | GITHUB_RATE_LIMIT | 13.1 | 515.2 | 545.3 |
| elixir | GITHUB_RATE_LIMIT | 0.9 | 527.4 | 541.5 |
| swift | GITHUB_RATE_LIMIT | 8.3 | 2162.3 | 2181.6 |
| android | GITHUB_RATE_LIMIT | 0.8 | 2169.7 | 2188.6 |
| cpp | GITHUB_RATE_LIMIT | 1 | 1734 | 2580.2 |
| cpp | GITHUB_RATE_LIMIT | 20.8 | 577.2 | 2580.2 |
| cpp | GITHUB_RATE_LIMIT | 16.6 | 223.4 | 2580.2 |
| npmws | GITHUB_RATE_LIMIT | 5.2 | 1967.6 | 1986.8 |
| history | GITHUB_RATE_LIMIT | 0.7 | 528.6 | 543 |
| shapes-posix | GITHUB_RATE_LIMIT | 1 | 3029.1 | 6047.1 |
| shapes-posix | GITHUB_RATE_LIMIT | 5.6 | 1743.4 | 6047.1 |
| shapes-posix | GITHUB_RATE_LIMIT | 6.4 | 1244.6 | 6047.1 |

## Import request attribution and qualification

Issue `ed088358` separates the retained observations from counts derived from the
import code. The raw preparation rows retain three `GITHUB_RATE_LIMIT` refusals
for each worst row: C++ active attempt 7.203 s, full wall 2,580.215 s, provider
waits 1,734.021 + 577.242 + 223.375 s; POSIX shapes active attempt 17.061 s,
full wall 6,047.133 s, waits 3,029.098 + 1,743.358 + 1,244.642 s. These are
observations with failed attempts included, not a matched before/after result.
Their CLI import-call totals are 11 and 7, respectively; those are client calls,
not all internal Convex executions. Retained Rust recovery also recorded
`anonymous:2, app:4, server:2, user:0` before source progress. This supports shared
metadata quota exhaustion before installation-token selection, rather than an
importer-share refusal. The precise failing endpoint and credential for each
C++/POSIX attempt were not retained; no HTTP trace is reconstructed from a reset.

Structural counts for an import (not measured endpoint traces): `R` is the number
of source worker runs, `T` the required tree replies, `M` archive-missing or
rewritten source blobs, `F` the files in protocol 2, and `A` attribute rules read
for LFS pages. Healthy archive imports usually have `R=1`, `T=1`.

| Endpoint / transfer | Before this fix | Current path | Credential / bucket |
| --- | --- | --- | --- |
| `GET /repos/OWNER/NAME` | Start + each worker + publication; separate history authorization after ready | Same healthy count; exhausted public metadata can use a metadata-only App probe | Deployment token when configured, else anonymous; private reads additionally prove current importer access |
| Clerk OAuth token + `POST /applications/CLIENT/token` | One each per private authorization | Unchanged | Clerk is not GitHub; client Basic auth is App traffic, not the importer token |
| `GET /repos/OWNER/NAME/installation` + `POST /app/installations/ID/access_tokens` | One pair per transfer authorization when configured/installed | Same, plus one metadata-only pair only on quota recovery | App JWT; contents tokens remain scoped to a proven numeric repository ID |
| `GET /repos/OWNER/NAME/commits/REF` | One at start | One | Installation token when available; authorized fallback otherwise |
| `GET /repos/OWNER/NAME/git/trees/TREE` | One complete recursive tree, or bounded split/directory replies (`T`) | Unchanged | Same selected source credential |
| `GET /repos/OWNER/NAME/tarball/COMMIT`, then codeload | One per archive run (`R`), codeload follows without credentials | Unchanged | Source credential on API request; codeload is outside REST quota |
| `GET /repos/OWNER/NAME/git/blobs/OID` | `M` for archives; up to `F+A` for protocol 2 | Zero in source import | Previously the selected source credential's REST quota |
| `POST github.com/OWNER/NAME.git/git-upload-pack` | Separate history fetch after publication | Also one per count/byte-bounded missing-source page; a large blob streams as a singleton byte page | Selected source credential via Basic; Git transport, outside primary REST quota |
| LFS batch / object download | One batch per at most 100 unique oids, then each distinct object | Unchanged | Separate LFS bucket; public anonymous, private selected read token; downloads remain per distinct object |

The public metadata path tries `GITHUB_PUBLIC_TOKEN` first; a rejected token can
fall back to anonymous metadata. Source selection previously happened only after
that succeeded. The recovery now reaches the App's own quota without using App
metadata as proof of a person's private access. Publication and the separate
history fetch share the same recovery, with no new Convex call or idle work.
A missing App preserves the original provider reset and existing retry behavior.

[GitHub's rate-limit documentation](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
assigns anonymous REST traffic 60 requests/hour per originating IP, user traffic
a shared personal budget normally 5,000/hour, and installation tokens a separate
budget of at least 5,000/hour (which can scale with the installation). The
configured deployment token's exact bucket depends on its token kind; retained
counters do not prove its configuration. Secondary limits can also apply; Git
and LFS transfers are not evidence that all provider limits disappeared.

The synthetic omitted-archive guard fails on the old path at 12 and 212 REST
blob requests. The same imports now use six REST requests at either size and
one/three Git blob-page fetches. It also verifies exact completion. The older
paged path, large streamed fallback, byte-window storage, private access,
revocation, unavailable App, corrupt packs/deltas, failed sinks and provider
errors have affected regression coverage. Source and listing bytes remain in R2;
existing metadata windows, upload receipts and publication writes are reused.
There are no new tables, scheduling steps, quotas, waiting rules or user steps.

Live qualification remains open: no development deployment or fresh import is
claimed by this change. Both original public fixture repositories now return
HTTP 404; the zoo teardown removed them. Recreating/publishing repositories and
deploying backend code are outside this builder's authorization, so neither of
the two permitted reruns was launched. The authorized follow-up is at most two imports, the
retained C++ and POSIX source pins, after the accepted backend is deployed.
Capture reset waits, whole wall and active time, all internal Convex calls and
DB read/write bytes, plus host load/swap. The retained selected-function baseline
is C++ `stored`: 3 calls/36,029 read B, `publish`: 2 calls/33,461 read B/30,062
write B; POSIX `stored`: 1 call/1,610 read B, `publish`: 1 call/1,711 read B/3,887
write B. These are incomplete function cohorts, not total import billing. Missing
before totals and provider-header traces must stay unknown. Two observations do
not meet the interleaved-pair performance-claim method or establish a causal
wall-time gain; the healthy-wall/billed-I/O acceptance stays unticked.

## Per-repository timings

Seconds, Forge / plain Git. Forge landing times include hosted checks; Git push times exclude CI. Import uses total elapsed wall time including provider waits. `landReuse` is the legacy Lane C column; it does not establish which Lane was overtaken.

| Row | import | clone | start | save | sync | land | landReuse | conflict | resolve |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| go † | 19.169 / 1.064 | 1.308 / 1.585 | 2.706 / unrecorded | 3.363 / 1.76 | 6.772 / 0.835 | 197.437 / 1.892 | 258.016 / 2.573 | 14.749 / 0.879 | 251.932 / 2.019 |
| python † | 9.035 / 0.897 | 2.245 / 4.692 | 2.869 / unrecorded | 2.993 / 2.154 | 4.984 / 0.694 | 74.743 / 5.436 | 84.794 / 2.674 | 14.633 / 0.88 | 78.261 / 1.815 |
| rust | 13.923 / 2.891 | 0.82 / 1.203 | 2.019 / unrecorded | 3 / 1.789 | 4.912 / 0.591 | 81.19 / 1.831 | 181.991 / 2.165 | 12.117 / 0.605 | 113.799 / 1.567 |
| jvm | 294.706 / 4.338 | 0.751 / 1.29 | 2.084 / unrecorded | 2.971 / 2.112 | 4.96 / 0.654 | 531.284 / 1.8 | 464.256 / 2.416 | 12.158 / 0.635 | 495.346 / 1.627 |
| mixed | 2,042.647 / 3.359 | 1.021 / 1.057 | 2.874 / unrecorded | 2.652 / 1.592 | 4.477 / 0.63 | 123.774 / 1.795 | 283.953 / 2.127 | 12.261 / 0.836 | 143.065 / 1.572 |
| csharp | 2,041.835 / 4.179 | 1.104 / 0.98 | 2.867 / unrecorded | 2.839 / 2.193 | 4.582 / 0.86 | 110.719 / 1.71 | 85.669 / 2.124 | 12.095 / 0.607 | 83.626 / 1.722 |
| electron | 545.291 / 0.653 | 0.632 / 0.715 | 1.761 / unrecorded | 2.866 / 1.604 | 4.389 / 0.59 | 62.875 / 4.698 | 138.15 / 2.129 | 12.221 / 0.593 | 83.221 / 1.621 |
| elixir | 541.478 / 1.006 | 0.756 / 1.001 | 1.562 / unrecorded | 2.54 / 1.509 | 4.691 / 0.621 | 68.225 / 1.611 | 76.268 / 2.053 | 12.53 / 0.609 | 78.17 / 1.641 |
| ruby | 8.491 / 1.095 | 0.735 / 1.117 | 1.43 / unrecorded | 2.756 / 1.81 | 4.27 / 0.589 | 98.397 / 1.979 | 110.605 / 2.497 | 12.574 / 0.577 | 154.068 / 1.823 |
| php | 13.006 / 0.854 | 0.708 / 0.822 | 1.57 / unrecorded | 2.774 / 1.753 | 4.984 / 0.602 | 58.968 / 1.964 | 69.65 / 2.22 | 11.809 / 0.708 | 63.024 / 2.082 |
| swift | 2,181.585 / 0.871 | 0.747 / 0.976 | 1.723 / unrecorded | 2.558 / 1.675 | 4.887 / 0.579 | 123.511 / 1.815 | 274.533 / 2.115 | 12.296 / 0.593 | 151.189 / 1.667 |
| android | 2,188.635 / 0.705 | 0.849 / 0.849 | 1.747 / unrecorded | 2.743 / 1.651 | 4.511 / 0.595 | 213.35 / 1.707 | 167.084 / 2.285 | 12.632 / 0.638 | 223.381 / 1.638 |
| dart | 7.771 / 0.762 | 0.707 / 0.716 | 1.539 / unrecorded | 2.568 / 1.566 | 5.071 / 0.58 | 82.085 / 1.892 | 64.438 / 2.338 | 12.404 / 0.592 | 77.058 / 1.676 |
| flutter | 12.872 / 0.781 | 0.837 / 0.779 | 1.631 / unrecorded | 2.665 / 1.562 | 4.851 / 0.602 | 137.228 / 1.747 | 164.993 / 2.124 | 11.637 / 0.607 | 156.071 / 1.611 |
| cpp | 2,580.215 / 4.845 | 0.842 / 2.049 | 1.591 / unrecorded | 2.529 / 1.793 | 4.98 / 0.612 | 228.775 / 2.105 | 251.84 / 2.209 | 12.667 / 0.67 | 175.669 / 1.678 |
| zig | 8.04 / 0.71 | 0.634 / 0.757 | 1.71 / unrecorded | 2.52 / 1.547 | 5.448 / 0.561 | 175.136 / 1.795 | 370.958 / 2.163 | 12.231 / 0.607 | 142.018 / 1.994 |
| npmws | 1,986.802 / 0.801 | 0.611 / 0.769 | 2.347 / unrecorded | 2.586 / 1.566 | 4.755 / 0.622 | 55.465 / 1.817 | 62.894 / 2.247 | 11.801 / 0.586 | 61.313 / 1.672 |
| lfs | 12.654 / 1.02 | 0.755 / 3.125 | 1.474 / unrecorded | 2.45 / 2.788 | 4.397 / 0.88 | 72.628 / 5.995 | 93.573 / 3.66 | 12.338 / 0.604 | 61.265 / 2.906 |
| history | 543.019 / 1.186 | 0.846 / 1.473 | 7.468 / unrecorded | 2.798 / 1.855 | 4.176 / 0.614 | 82.067 / 1.793 | 151.98 / 2.225 | 11.86 / 0.605 | 95.65 / 1.686 |
| binaries | 24.342 / 2.503 | 1.454 / 3.089 | 4.887 / unrecorded | 2.646 / 1.901 | 5.668 / 0.584 | 68.195 / 4.706 | 117.582 / 2.162 | 12.428 / 0.58 | 68.471 / 1.597 |
| shapes-posix | 6,047.133 / 3.087 | 0.637 / 0.605 | 1.539 / unrecorded | 2.512 / 1.499 | 4.424 / 0.601 | 62.219 / 1.681 | 69.786 / 2.312 | 11.725 / 0.598 | 73 / 1.693 |
| shapes-bigbin | 34.24 / 2.127 | 0.85 / 2.307 | 1.881 / unrecorded | 2.808 / 1.833 | 4.559 / 0.724 | 81.288 / 1.882 | 89.194 / 2.689 | 12.641 / 1.054 | 60.536 / 1.888 |
| shapes-case | 8.267 / 0.641 | 0.66 / 0.627 | 1.734 / unrecorded | 2.545 / 1.404 | 5.39 / 0.583 | 69.74 / 1.71 | 55.682 / 2.124 | 12.23 / 0.585 | 63.553 / 1.609 |
| shapes-collide | 16.822 / 0.558 | 1.014 / unrecorded | – | – | – | – | – | – | – |
| shapes-nonutf8 | 1.789 / unrecorded | – | – | – | – | – | – | – | – |
| shapes-unicode | 8.305 / 0.633 | 1.044 / unrecorded | – | – | – | – | – | – | – |

† Go and Python passed all nine paths before the local Lane directory disappeared. Their numeric results were observed and reconstructed from tool output; the original raw row files were lost. Replacement Rust/JVM and subsequent rows retain their raw receipts. No missing raw result was fabricated. Python’s successful import took 9.035 s; its earlier setup refusal has no retained total wall time.

## Timing qualification

Rust’s original C result was 167.752 s against an 82.406 s baseline. The original C was actually overtaken and rechecked for `global-risk`; baseline C landed first. The reversed order remains visible and the strict C-column timing threshold is unchanged. The old 88.194 s repeat landed C first and is unmatched; its later resolution failed, which led to the generic original-operation continuation fix.

| Fresh repeat | C seconds | Import wall s | Import active s | Provider voids | Accepted | Actual C overtake | Scope |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Replacement full row | 181.991 | 13.923 | 13.923 | 0 | yes | yes, global-risk recheck | all nine paths |
| Target 1 | 169.42 | 76.66 | 76.66 | 0 | yes | yes | through both terminal A/C landings |
| Target 2 | 178.276 | 1,792.129 | 16.35 | 1 | yes | yes | through both terminal A/C landings |
| Target 3 | 75.972 | 13.946 | 13.946 | 0 | yes | no; not counted | through both terminal A/C landings |
| Target 4 | 146.82 | 13.933 | 13.933 | 0 | yes | yes | through both terminal A/C landings |
| Target 5 | 164.981 | 5,392.718 | 10.93 | 3 | yes | yes | through both terminal A/C landings |

5 matched repeats retained; median 169.42 s (2.056× baseline). A target repeat ends only after both A/C landings settle; later sync/conflict/resolve are deliberately unrun in that repeat. The replacement full Rust row covers those paths. All attempts remain listed. The five target-import wall times have a median of 76.66 s, versus 17.492 s import baseline; this is also a strict wall-time miss. Their successful-attempt median is 13.946 s. Provider waits stay charged to elapsed time, so the successful-attempt median does not replace the wall-time verdict.

JVM’s original import wall time was 2,018.566 s (10.869 s successful active import), and its replacement was 294.706 s (6.200 s successful active import). Both include GitHub rate-reset waits. Five fresh imports of the same source took 13.939, 18.999, 7.746, 7.713, 7.682 s; median 7.746 s against 17.372 s baseline. The repeats were observed before raw artifact loss. Provider waits are setup voids, not hidden by the active-time number.

## DB I/O and catalog reads

The total project-attributed meter is 402.835 decimal MB (17,691 executions), including failed attempts, timing repeats and captured cleanup. The conservative budget counter is 580.571 / 600 MB: project usage plus the entire day’s 140.140693 MB owner-catalog billing reserve plus 36.595 MB of live owner-catalog observations, plus 1 MB reserved for an indexed recovery diagnostic without independent byte attribution. The daily reserve includes earlier/other work that the date-only billing API cannot separate; it is an upper-bound reservation, not an attributed zoo cost. Live catalog bytes may overlap the daily reserve. Auxiliary function attribution is already in project usage and is never added twice.

`projectBackups:list` reads the owner’s project catalog (`hostedProjects`), not the object catalog. Its normal import and landing paths make zero direct calls to it. Teardown discovers fixtures with paged reads, and the current host-delete client repeatedly reads that catalog while waiting for purge; Issue `c088b39e-5059-469e-86c3-c38445bafbec` tracks this larger cost fix. One isolated owner-catalog traversal measured 194,981 DB-read bytes across three queries. Dividing the whole-day 140 MB by imported rows or landings would falsely attribute unrelated work. Final cleanup overhead is reported separately; normal-path catalog bytes per imported row and per landing are zero direct bytes for this function.

The table below covers six selected object-lookup RPCs over complete post-import scenarios. It sums billed DB reads in `projectConvexSourceObjects:resolve`, `projectObjects:available`, `projectObjects:prepareBatch`, `projectObjects:resolve`, `projectObjectDownloads:lanePage`, and `projectObjectDownloads:signDownloads`. These functions also read other metadata, and other source/check functions can perform catalog lookups. This is a selected RPC cohort, not a complete or isolated measurement of the catalog table or import phase. “Row” means one repository scenario; file normalization is shown separately. Per-landing bytes divide full-scenario reads by accepted landings; they are an amortization, not an isolated landing-operation measurement.

| Row | Files before / after | Landings before / after | DB-read B per row before → after | B per file before → after | B per landing before → after | Change |
| --- | --- | --- | --- | --- | --- | --- |
| rust | 228 / 228 | 3 / 3 | 1,680,204 → 1,620,039 | 7,369.316 → 7,105.434 | 560,068 → 540,013 | -3.581% |
| jvm | 194 / 194 | 3 / 3 | 1,616,661 → 1,551,784 | 8,333.304 → 7,998.887 | 538,887 → 517,261.333 | -4.013% |
| mixed | 88 / 88 | 3 / 3 | 1,038,490 → 975,232 | 11,801.023 → 11,082.182 | 346,163.333 → 325,077.333 | -6.091% |
| csharp | 99 / 99 | 3 / 3 | 1,104,965 → 1,042,108 | 11,161.263 → 10,526.343 | 368,321.667 → 347,369.333 | -5.689% |
| electron | 18 / 18 | 3 / 3 | 664,282 → 602,112 | 36,904.556 → 33,450.667 | 221,427.333 → 200,704 | -9.359% |
| elixir | 108 / 108 | 3 / 3 | 1,148,919 → 1,086,894 | 10,638.139 → 10,063.833 | 382,973 → 362,298 | -5.399% |
| ruby | 294 / 294 | 3 / 3 | 1,904,623 → 1,843,244 | 6,478.31 → 6,269.537 | 634,874.333 → 614,414.667 | -3.223% |
| php | 127 / 127 | 3 / 3 | 1,252,087 → 1,191,294 | 9,858.953 → 9,380.268 | 417,362.333 → 397,098 | -4.855% |
| swift | 287 / 287 | 3 / 3 | 1,906,236 → 1,844,777 | 6,641.937 → 6,427.794 | 635,412 → 614,925.667 | -3.224% |
| android | 44 / 44 | 3 / 3 | 810,113 → 745,257 | 18,411.659 → 16,937.659 | 270,037.667 → 248,419 | -8.006% |
| dart | 35 / 35 | 3 / 3 | 738,683 → 694,857 | 21,105.229 → 19,853.057 | 246,227.667 → 231,619 | -5.933% |
| flutter | 141 / 141 | 3 / 3 | 1,305,375 → 1,242,258 | 9,257.979 → 8,810.34 | 435,125 → 414,086 | -4.835% |
| cpp | 147 / 147 | 3 / 3 | 1,360,409 → 1,299,596 | 9,254.483 → 8,840.789 | 453,469.667 → 433,198.667 | -4.47% |
| zig | 22 / 22 | 3 / 3 | 683,446 → 621,636 | 31,065.727 → 28,256.182 | 227,815.333 → 207,212 | -9.044% |
| npmws | 23 / 23 | 3 / 3 | 687,933 → 602,217 | 29,910.13 → 26,183.348 | 229,311 → 200,739 | -12.46% |
| lfs | 188 / 188 | 3 / 3 | 1,706,287 → 1,644,590 | 9,075.995 → 8,747.819 | 568,762.333 → 548,196.667 | -3.616% |
| history | 402 / 402 | 3 / 3 | 1,549,066 → 1,690,543 | 3,853.398 → 4,205.331 | 516,355.333 → 563,514.333 | 9.133% |
| binaries | 1387 / 1387 | 3 / 3 | 1,885,072 → 1,853,498 | 1,359.1 → 1,336.336 | 628,357.333 → 617,832.667 | -1.675% |
| shapes-posix | 12 / 12 | 3 / 3 | 627,093 → 566,687 | 52,257.75 → 47,223.917 | 209,031 → 188,895.667 | -9.633% |
| shapes-bigbin | 8 / 8 | 3 / 3 | 1,561,947 → 1,495,756 | 195,243.375 → 186,969.5 | 520,649 → 498,585.333 | -4.238% |
| shapes-case | 6 / 6 | 3 / 3 | 599,863 → 537,954 | 99,977.167 → 89,659 | 199,954.333 → 179,318 | -10.321% |

All increases in this selected cohort are retained below, even when its scenario total decreased.

| Row / function | Calls before → after | DB-read bytes before → after | Increase per landing |
| --- | --- | --- | --- |
| rust / `projectObjects:available` | 12 → 12 | 392,487 → 392,511 | 8 B |
| rust / `projectObjects:prepareBatch` | 9 → 9 | 399,042 → 400,032 | 330 B |
| rust / `projectObjects:resolve` | 2 → 2 | 44,602 → 44,604 | 0.667 B |
| rust / `projectObjectDownloads:lanePage` | 10 → 10 | 20,944 → 20,964 | 6.667 B |
| rust / `projectObjectDownloads:signDownloads` | 1 → 1 | 3,713 → 3,715 | 0.667 B |
| jvm / `projectObjects:prepareBatch` | 9 → 10 | 378,369 → 378,898 | 176.333 B |
| mixed / `projectObjects:available` | 12 → 12 | 184,064 → 184,071 | 2.333 B |
| php / `projectObjects:prepareBatch` | 9 → 9 | 260,505 → 260,991 | 162 B |
| android / `projectObjects:available` | 12 → 12 | 109,457 → 109,488 | 10.333 B |
| dart / `projectObjects:available` | 12 → 12 | 85,420 → 93,723 | 2,767.667 B |
| dart / `projectObjects:prepareBatch` | 9 → 9 | 91,975 → 101,250 | 3,091.667 B |
| cpp / `projectObjects:prepareBatch` | 9 → 9 | 295,740 → 296,226 | 162 B |
| lfs / `projectObjects:available` | 12 → 12 | 398,916 → 398,940 | 8 B |
| lfs / `projectObjects:resolve` | 4 → 4 | 47,412 → 47,416 | 1.333 B |
| lfs / `projectObjectDownloads:lanePage` | 12 → 12 | 25,036 → 25,060 | 8 B |
| lfs / `projectObjectDownloads:signDownloads` | 1 → 1 | 3,717 → 3,719 | 0.667 B |
| history / `projectConvexSourceObjects:resolve` | 32 → 27 | 710,320 → 790,516 | 26,732 B |
| history / `projectObjects:available` | 12 → 12 | 384,948 → 405,213 | 6,755 B |
| history / `projectObjects:prepareBatch` | 9 → 9 | 392,439 → 413,190 | 6,917 B |
| history / `projectObjects:resolve` | 2 → 2 | 32,502 → 52,767 | 6,755 B |
| binaries / `projectObjects:available` | 12 → 12 | 450,383 → 465,696 | 5,104.333 B |
| binaries / `projectObjects:prepareBatch` | 9 → 9 | 457,868 → 472,695 | 4,942.333 B |
| shapes-posix / `projectObjects:available` | 12 → 12 | 49,332 → 53,052 | 1,240 B |
| shapes-posix / `projectObjects:prepareBatch` | 9 → 9 | 57,735 → 60,003 | 756 B |

Additional catalog lookups occur in hosted source/check paths. For example, `projectHostedActionsSource:resolve` also calls the catalog lookup helper. Its full function DB-read bytes and all-function scenario reads are shown separately to keep the selected cohort explicit. Neither column isolates catalog table bytes.

| Row | Actions source resolve calls before → after | Its DB-read B before → after | Its B per landing before → after | All-function DB-read B per row before → after | All-function B per landing before → after |
| --- | --- | --- | --- | --- | --- |
| rust | 11 → 11 | 385,580 → 387,602 | 128,526.667 → 129,200.667 | 11,124,789 → 10,739,881 | 3,708,263 → 3,579,960.333 |
| jvm | 12 → 12 | 369,974 → 372,124 | 123,324.667 → 124,041.333 | 10,196,104 → 10,142,874 | 3,398,701.333 → 3,380,958 |
| mixed | 11 → 11 | 200,342 → 202,320 | 66,780.667 → 67,440 | 9,406,801 → 8,935,376 | 3,135,600.333 → 2,978,458.667 |
| csharp | 12 → 12 | 224,575 → 226,701 | 74,858.333 → 75,567 | 9,217,558 → 8,765,541 | 3,072,519.333 → 2,921,847 |
| electron | 13 → 13 | 105,382 → 108,036 | 35,127.333 → 36,012 | 8,430,573 → 7,825,898 | 2,810,191 → 2,608,632.667 |
| elixir | 12 → 12 | 237,660 → 239,816 | 79,220 → 79,938.667 | 9,246,425 → 9,023,023 | 3,082,141.667 → 3,007,674.333 |
| ruby | 12 → 12 | 461,828 → 463,978 | 153,942.667 → 154,659.333 | 11,287,194 → 10,786,182 | 3,762,398 → 3,595,394 |
| php | 12 → 12 | 267,596 → 269,750 | 89,198.667 → 89,916.667 | 9,425,506 → 8,971,815 | 3,141,835.333 → 2,990,605 |
| swift | 11 → 11 | 461,109 → 463,107 | 153,703 → 154,369 | 11,683,359 → 11,390,270 | 3,894,453 → 3,796,756.667 |
| android | 12 → 12 | 139,912 → 142,062 | 46,637.333 → 47,354 | 8,381,958 → 7,816,836 | 2,793,986 → 2,605,612 |
| dart | 12 → 12 | 125,622 → 127,774 | 41,874 → 42,591.333 | 7,953,001 → 7,617,853 | 2,651,000.333 → 2,539,284.333 |
| flutter | 12 → 12 | 281,752 → 283,902 | 93,917.333 → 94,634 | 9,650,155 → 9,146,491 | 3,216,718.333 → 3,048,830.333 |
| cpp | 12 → 12 | 298,076 → 300,226 | 99,358.667 → 100,075.333 | 9,615,605 → 9,254,216 | 3,205,201.667 → 3,084,738.667 |
| zig | 11 → 11 | 100,897 → 102,897 | 33,632.333 → 34,299 | 8,446,778 → 8,093,893 | 2,815,592.667 → 2,697,964.333 |
| npmws | 12 → 12 | 106,458 → 108,584 | 35,486 → 36,194.667 | 7,742,121 → 7,936,938 | 2,580,707 → 2,645,646 |
| lfs | 20 → 20 | 764,926 → 768,312 | 254,975.333 → 256,104 | 11,030,206 → 10,662,563 | 3,676,735.333 → 3,554,187.667 |
| history | 13 → 11 | 554,531 → 471,559 | 184,843.667 → 157,186.333 | 11,695,258 → 11,616,843 | 3,898,419.333 → 3,872,281 |
| binaries | 35 → 35 | 4,835,526 → 4,336,796 | 1,611,842 → 1,445,598.667 | 17,604,822 → 16,311,375 | 5,868,274 → 5,437,125 |
| shapes-posix | 14 → 14 | 100,098 → 102,872 | 33,366 → 34,290.667 | 7,979,595 → 7,608,220 | 2,659,865 → 2,536,073.333 |
| shapes-bigbin | 20 → 20 | 680,134 → 683,484 | 226,711.333 → 227,828 | 10,638,516 → 10,540,436 | 3,546,172 → 3,513,478.667 |
| shapes-case | 14 → 14 | 91,712 → 93,856 | 30,570.667 → 31,285.333 | 7,713,429 → 7,364,224 | 2,571,143 → 2,454,741.333 |

The old source SHA was not retained and multiple P6 changes landed between cohorts. File counts and accepted-landing counts are shown, but equal counts do not prove equal source or execution. JVM’s retained baseline also has an earlier `gradlew.bat` size mismatch, fixed before the current run. These observations cannot causally isolate storeD (`d16daa46`, `c9813bd1`, `0987b76c`). The [parent of d16daa46 already set objectCatalogPage to 256](https://github.com/NanthAI/nanthai-forge/blob/9d54040a5bcd739a52296e3f9af9a61e3a76aa70/convex/projectObjectFind.ts#L8), and GitHub import referenced that constant. StoreD compacted older immutable bindings while new small worker outputs retain raw rows. No before/after import-phase catalog-read comparison is claimed where historical read attribution is unavailable.

## Timing overruns and qualification

This table retains every observed strict 1.5× overrun in the completed rows. “Unqualified” means no five-repeat verdict was called for that additional observation. It is not a claim that the timing passed. The unchanged default harness also retains its existing +5 s noise allowance.

| Row / operation | Baseline s | Observed s | Ratio | Qualification |
| --- | --- | --- | --- | --- |
| rust / landReuse | 82.406 | 181.991 | 2.208× | five fresh actual C overtakes: median 169.420 s (2.056×); strict miss, baseline-order mismatch retained |
| jvm / import | 17.372 | 294.706 | 16.965× | five fresh import median 7.746 s (0.446×), within bar; original provider wait remains visible |
| mixed / import | 14.350 | 2042.647 | 142.341× | unqualified observation; no five additional repeats |
| csharp / import | 14.258 | 2041.835 | 143.209× | unqualified observation; no five additional repeats |
| electron / import | 14.098 | 545.291 | 38.677× | unqualified observation; no five additional repeats |
| elixir / import | 13.911 | 541.478 | 38.924× | unqualified observation; no five additional repeats |
| swift / import | 29.373 | 2181.585 | 74.271× | unqualified observation; no five additional repeats |
| swift / landReuse | 132.293 | 274.533 | 2.075× | unqualified observation; no five additional repeats; baseline C first, current C global-risk recheck |
| android / import | 16.344 | 2188.635 | 133.907× | unqualified observation; no five additional repeats |
| cpp / import | 20.365 | 2580.215 | 126.697× | unqualified observation; no five additional repeats |
| npmws / import | 13.536 | 1986.802 | 146.783× | unqualified observation; no five additional repeats |
| history / import | 20.783 | 543.019 | 26.128× | unqualified observation; no five additional repeats |
| shapes-posix / import | 19.222 | 6047.133 | 314.594× | unqualified observation; no five additional repeats |
| rust / target-repeat import preparation | 17.492 | 76.660 (five-repeat median) | 4.383× | strict wall-time miss; active-attempt median retained separately |

## Repositories and check evidence

The upstream CI command and toolchain declarations are retained in the [catalog](../../scripts/bench-zoo/catalog.json). Each plain GitHub run uses the same declared command as its Forge check. Git push times in the timing table exclude CI. Job counts can exceed check-run counts because workflows contain setup or other jobs.

| Row | Upstream / fixture | Plain GitHub run | Full check s | Forge runs / jobs | Forge job s | Fixture source commit | CLI build State prefixes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| go | prometheus/client_golang | 42903540647 (success) | 199 | unrecorded / unrecorded | unrecorded | 707d36f65c16511a2d261b04a97862c0029494a9 | unrecorded |
| python | tree-sitter/py-tree-sitter | 42902616569 (success) | 20 | unrecorded / unrecorded | unrecorded | cad717409998fa693c0a40c8f836decc63948bc7 | unrecorded |
| rust | BurntSushi/ripgrep | 42924254003 (success) | 32 | 4 / 6 | 304 | f64a4c1e3a0041b59e517c2d76001e9f288cd6c2 | 77a86a4a29a8 → 88f8dab9aca6 |
| jvm | square/kotlinpoet | 42926188430 (success) | 561 | 3 / 5 | 1420 | fca192af8eae19dbf54cff8313c22f163e55b1b3 | 88f8dab9aca6 → 5b6b103f787a |
| mixed | pydantic/jiter | 42936870701 (success) | 78 | 4 / 6 | 476 | 1c17b19f194a2a9411f5173aa69a1b630f952abc | 9f9f0a545036 → 0c44e3662241 |
| csharp | ardalis/GuardClauses | 42936311039 (success) | 37 | 4 / 6 | 252 | 2287dfc716831728d5b704798753734818091de3 | 9f9f0a545036 → 0c44e3662241 |
| electron | sindresorhus/electron-store | 42938875309 (success) | 22 | 4 / 8 | 243 | 41cf153b1a1b650bed9a3b343347d4fcc1f22176 | 0c44e3662241 |
| elixir | elixir-plug/plug | 42938725453 (success) | 26 | 4 / 6 | 200 | a0c9b6f322b46b40bb00a9e8211ae8e11df1d514 | 0c44e3662241 |
| ruby | sinatra/sinatra | 42939718752 (success) | 39 | 4 / 6 | 337 | 5737f88dde6473449395518450c13fc551d0ab56 | 0c44e3662241 |
| php | guzzle/psr7 | 42939442180 (success) | 11 | 4 / 6 | 155 | bb3caad9a54ae447adfbd1cc241a285e4858c47b | 0c44e3662241 |
| swift | apple/swift-argument-parser | 42945172969 (success) | 68 | 4 / 6 | 472 | 66ed0a4d5287d7de8e8ae07019a6944c5c21b503 | 0c44e3662241 |
| android | JakeWharton/timber | 42945186760 (success) | 142 | 4 / 6 | 699 | 2e0257a112ef2fd843c97afb9c42d4afe9bf7198 | 0c44e3662241 |
| dart | felangel/equatable | 42946003521 (success) | 22 | 4 / 6 | 201 | 841168e08ba456d15a7f7bb17312dd22e7958286 | 0c44e3662241 |
| flutter | rrousselGit/flutter_hooks | 42946306492 (success) | 107 | 4 / 6 | 535 | 1360a4eafefc7b9f398cd41e44039a4cfccbe25f | 0c44e3662241 |
| cpp | fmtlib/fmt | 42952388692 (success) | 82 | 4 / 6 | 562 | 6101474b6259dad138f97d0034ca3ce1bb3034f3 | 0c44e3662241 |
| zig | Hejsil/zig-clap | 42952543783 (success) | 135 | 4 / 6 | 501 | 4abecfce57efa877d174a62f6a195b57de7600c4 | 0c44e3662241 |
| npmws | Quramy/npm-ts-workspaces-example | 42956770482 (success) | 7 | 4 / 6 | 143 | 433ddb2819524b451d2d6b401a7d452751d500d8 | 0c44e3662241 |
| lfs | learningequality/morango | 42956860728 (success) | 4 | 4 / 6 | 193 | bfea22905b7e29e4fb33ea9c4d4166be5c3d6b8a | 0c44e3662241 |
| history | jashkenas/underscore | 42958563606 (success) | 24 | 4 / 6 | 254 | fe931ebba4cffef0c2ef0771833bc3e786c3f96b | 0c44e3662241 |
| binaries | kripken/ammo.js | 42958463229 (success) | 7 | 4 / 6 | 187 | 10817e07e32be608abe67cbefa6473c35507dc2b | 0c44e3662241 |
| shapes-posix | synthetic posix | 42970285601 (success) | 5 | 4 / 8 | 187 | 5eee54351f33ce0855239960314e26fda5435a32 | 0c44e3662241 |
| shapes-bigbin | synthetic bigbin | 42968424003 (success) | 5 | 4 / 6 | 200 | 959365d71dcaea425bb0227a455e835d1c4c64f2 | 0c44e3662241 |
| shapes-case | synthetic case | 42971033935 (success) | 6 | 4 / 8 | 180 | 591826d065403765539d8a5d03ac7c52b4f54073 | 0c44e3662241 |
| shapes-collide | synthetic collide | unrun: named refusal (unrun) | unrecorded | unrecorded / unrecorded | unrecorded | 9eae9018539bf788e45c45b03a96b063ae189168 | 0c44e3662241 |
| shapes-nonutf8 | synthetic nonutf8 | unrun: named refusal (unrun) | unrecorded | unrecorded / unrecorded | unrecorded | fde2c85dfd3d240653f2ab641c644a6e3619b024 | 0c44e3662241 |
| shapes-unicode | synthetic unicode | unrun: named refusal (unrun) | unrecorded | unrecorded / unrecorded | unrecorded | 0167ba1ee0a625b3e144c632671e019ad2675ba7 | 0c44e3662241 |

CLI build identifiers are accepted source-State digests, not GitHub commit SHAs; a batch can straddle a launcher update. Full retained build States: `77a86a4a29a86f9a47dc998093d37a71af4d7eb4b713af58ff14dd00ed8b7a98`, `88f8dab9aca6267f57c3d1b029a51d64e518409fa993e5e87b11a5bc04218a93`, `5b6b103f787afc2dcb898678b75b2e2c95c6806b8db33109c6c1a415aa4d3ea7`, `9f9f0a545036968d001eae830688207d2c823ab928ec5144eadd6ff7404e0b00`, `0c44e3662241a41b1a1c3223d3a56b2892be71a9ddca913ab0280e038153c063`. Go/Python build pins were not retained in their lost raw rows.

The replacement Rust/JVM rows were prepared before source-commit retention was added: their pinned import commits are independently retained in preparation state and were checked against their GitHub full runs. Current source commits in the table are recorded directly by later rows. Go/Python commit evidence above is from their original completed GitHub runs. Named hazard refusals show the fixture SHA observed on GitHub before import; that is not a claim of an imported or checked source. Old before-storeD source SHAs remain unrecorded. Fixture repositories are disposable; their run IDs and measured metadata are retained before teardown rather than relying on links surviving repository deletion.

## Fresh-import catalog attribution

The auxiliary provider stream captures function read/write bytes from 00:28:43 UTC onward and is already included in the primary project meter. This table covers fresh main-matrix imports in that stream; no historical import-phase byte comparison is available. `projectGithubImportCatalog:stored` reads stored upload-window inventory plus job metadata; it is distinct from both `projectBackups:list` and final `projectObjectCatalog` page lookup. The new-import inventory can be empty on its first worker.

| Row | Imported files | stored calls | stored DB-read B per repository row | B per imported file | publish DB-read B | publish DB-write B |
| --- | --- | --- | --- | --- | --- | --- |
| mixed | 88 | 1 | 1561 | 17.739 | 1662 | 18482 |
| csharp | 99 | 1 | 1568 | 15.838 | 1669 | 20798 |
| electron | 18 | 1 | 1582 | 87.889 | 1683 | 5165 |
| elixir | 108 | 1 | 1568 | 14.519 | 1669 | 22415 |
| ruby | 294 | 1 | 1554 | 5.286 | 1655 | 53729 |
| php | 127 | 1 | 1545 | 12.165 | 1646 | 26202 |
| swift | 287 | 3 | 60640 | 211.289 | 58870 | 55586 |
| android | 44 | 1 | 1577 | 35.841 | 1678 | 10183 |
| dart | 35 | 1 | 1558 | 44.514 | 1659 | 8446 |
| flutter | 141 | 1 | 1579 | 11.199 | 1680 | 27939 |
| cpp | 147 | 3 | 36029 | 245.095 | 33461 | 30062 |
| zig | 22 | 1 | 1551 | 70.500 | 1652 | 5937 |
| npmws | 23 | 1 | 1561 | 67.870 | 1662 | 6130 |
| lfs | 188 | 1 | 1569 | 8.346 | 1670 | 42351 |
| history | 402 | 1 | 1579 | 3.928 | 1680 | 79325 |
| binaries | 1387 | 1 | 1582 | 1.141 | 1683 | 283337 |
| shapes-posix | 12 | 1 | 1610 | 134.167 | 1711 | 3887 |
| shapes-bigbin | 8 | 1 | 1617 | 202.125 | 1718 | 37014 |
| shapes-case | 6 | 1 | 1603 | 267.167 | 1704 | 2849 |
| shapes-collide | 8 | 1 | 1624 | 203.000 | 1725 | 3235 |
| shapes-unicode | 6 | 1 | 1624 | 270.667 | 1725 | 2849 |

## On-demand run

Use Node 24.22.1 or newer in the 24.x line and the approved installed CLI. `ZOO_ROOT` is an isolated scratch folder with the deployment, CLI checkout and meter working-directory configuration in `zoo.json`; no credentials belong in the report or source. The commands operate on disposable dev fixtures:

```sh
node scripts/bench-zoo/suite.mjs provision ZOO_ROOT
node scripts/bench-zoo/suite.mjs verify ZOO_ROOT
nforge heavy node scripts/bench-zoo/suite.mjs run ZOO_ROOT --concurrency 2 --baseline scripts/bench-zoo/baseline.json
node scripts/bench-zoo/suite.mjs report ZOO_ROOT --baseline scripts/bench-zoo/baseline.json
node scripts/bench-zoo/suite.mjs teardown ZOO_ROOT
```

`run` follows the four-Lane scenario, then writes `SUITE.md` and `SUITE.json`; `report` is offline. The baseline guard exits nonzero when a previously passing path fails or an operation exceeds 1.5× baseline plus its existing 5 s noise allowance. The brief's strict 1.5× checks are also retained in this run's audit. Baseline numeric times were not changed. Source commits and actual A/C landing classes are now retained in future results and baselines.

The paths judged are import, clone, fidelity, save, sync, A land, C land, conflict and resolution. Fidelity compares paths, file kinds/modes, sizes and link targets with Git's checkout of the same fork; synthetic checks also assert their fixture bytes, hashes and path shapes. Paths Git itself cannot write on the host are recorded as platform limits. Expected hazards require exactly `GITHUB_SOURCE_UNSUPPORTED` during import or `INVALID_NATIVE_SOURCE` during clone; authentication, rate and unknown refusals fail the row.

Named GitHub rate resets retain the failed attempt and reset time, wait locally, then resume the same operation and pinned source. Source timeouts likewise reconcile the original operation before advancing. Every continuation remains in the wall-time measurement. Import start/status transport failures retain the original operation and job journal; bounded reconciliation records failed calls and wait clocks. One LFS status reply timed out after 120 seconds although the server import reached ready. The original project was reconciled before a deliberate fresh replacement imported the same commit in 12.654 seconds; the failed attempt remains in aggregate cost and teardown scope. An unfinished operation stops the row with its replay data and checkout retained; a terminal failed resolution never advances to land. The shared import helper also loads standalone SDK dependencies only in its CLI entry point, so the reusable recovery path works in an unbuilt source checkout with the configured installed CLI. These changes merge landing-only recovery into shared source recovery, with zero extra healthy-path or idle calls. They add no tables or source-byte copies.

Teardown reads matching project metadata by page, including older imports absent from `state.json`, and uses each project's exact current slug, including numeric suffixes. It starts every purge before later pending rounds, retains purge receipts in `teardown.json`, and clears state only after server purge confirmation. This removes forgotten/suffixed fixture leaks. The current host-delete client's owner-catalog polling remains a separate open cost issue; no retention period or purge lease was shortened.

## Generic fixes and verification

| Fix | Issue | Accepted receipt | GitHub mirror SHA |
| --- | --- | --- | --- |
| Exact suffixed slugs and forgotten imports | parent 70a9bd2f | 54fd0e5c-2956-4f56-b30d-b7afc2e3d6be | 26fa138f08e9d57d99e8ebe6dce4a23751d23430 |
| Request all purges before pending rounds | parent 70a9bd2f | d84432eb-f132-4a37-98a4-a6ba012610d9 | dffaa2a5eb0a2d32ad9310e7de455246411d7579 |
| Retain and resume provider reset operations | ea0bc2e6 | 845bed03-4484-4fc1-8eea-ba57e167d4fc | af40006d8be2259976df06fa347772474e8eaf22 |
| Guard full import wall time | ea0bc2e6 | b9a391df-80d0-4a34-a65b-8a51016242b2 | c90546a35dc22870927e4aada372ff7347b96e51 |
| Original source-operation continuation; phase-specific hazards | 95e39ecf, 7bce7c1a | e5f78c2c-f0a2-468b-8f6e-88f1612e96e7 | 4f8a98502d8844cea608d69edba83a73930ac3d6 |
| Preserve active local process roots during automatic cache cleanup | d9eded54 | 4a5eaea7-3ef2-40de-89f4-8267a5d3bad0 | 3654792f0d7fdcada5898f966e826335d80b696b |

Each fix was checked on accepted main after a separate pull and matched to its GitHub SHA. The hosted full check passed 955 files for each accepted fix; two admissions included an archive-memory retry that passed without weakening its guard. Local targeted checks grew from 28 to 46 zoo cases, all passing; the process-cleanup fix passed 30 affected cases. Full verification was left to the hosted landing runner. The lead owns the subsequent Linux runner test-isolation correction for the process guard.

Automatic cache cleanup reuses the explicit cleanup process guard and existing bounded eviction log. It batches one local process scan only when an eligible root exists; an uncertain scan preserves the root. It adds no Convex or idle calls. The original Lane-directory disappearance coincided with a cache GC stamp; that is a plausible cause, not a proven deletion receipt. Accepted source survived; replacement benchmark artifacts have remained intact.

This report replaces the accumulated mini-run history. The code changes reuse existing recovery, cleanup, logging and report mechanisms; no new command, public error, table, service or quota was introduced. Larger host-delete catalog polling work remains tracked in P6 rather than being hidden by a fixture-only workaround.

## Rust check and overtake diagnosis

The timing columns measure landing wall time, including runner preparation and any second run. They are not Cargo test duration. Retained baseline and replacement run records distinguish those clocks:

| Row / Lane | Run | Command execution s | Enqueue to terminal s |
| --- | --- | --- | --- |
| Baseline C | admission, landed first | 20.946 | 66.184 |
| Baseline A | admission | 28.194 | 73.717 |
| Baseline A | combined recheck | 31.591 | 68.197 |
| Baseline B | resolved solo check | 20.838 | 50.014 |
| Replacement A | admission, landed first | 23.646 | 65.997 |
| Replacement C | admission | 26.861 | 73.743 |
| Replacement C | combined recheck | 45.262 | 84.809 |
| Replacement B | resolved solo check | 43.767 | 84.169 |

The zoo installs `bash .forge-zoo/ci.sh`, containing `cargo build --verbose --workspace` followed by `cargo test --verbose --workspace`, in both Forge and the plain GitHub workflow. Rust declares no extra toolchain or dependency cache. Both retained Forge jobs report `ubuntu-26.04`, image `20261101.186.1`; that image lists Rust/Cargo 1.99.1. [Baseline job](https://github.com/NanthAI/nanthai-forge/actions/runs/42751904996) and [replacement admission](https://github.com/NanthAI/nanthai-forge/actions/runs/42923483250) logs show cold crate downloads and compilation. The build and test commands share `target/` within one job; neither `target/` nor the registry is restored between these jobs. Forge's Node/control-runtime cache hits are separate. The declared Cargo preset, when used by a project, restores dependency downloads only; it does not restore Candidate build outputs.

For the baseline C job, Cargo reports 8.87 s to finish the build and 6.60 s to finish test compilation; replacement A reports 10.34 / 7.42 s. The replacement combined check reports 25.87 / 8.60 s. First download bursts in those two admission jobs last about 0.2–0.3 s. Check duration varies, including a slower resolved B job, but this evidence does not show one Rust check taking 300 seconds. All show ripgrep 15.2.0. The replacement source is `f64a4c1e3a0041b59e517c2d76001e9f288cd6c2`; the exact original fork SHA was not retained and its deleted fork/run cannot now establish whether upstream bytes changed. Matching package versions and runner images do not prove identical source.

The baseline overtaken A took 168.367 s, beside first-to-land C at 82.406 s. Replacement C took 181.991 s because it became the overtaken Lane. Its first check ended at 23:28:27.722; the combined check was enqueued at 23:28:37.591 and ended at 23:30:02.400. The unchanged strict C baseline and five-repeat miss remain in force. A cache-key change cannot remove that serial second check; no Rust-only cache or timing exemption has been added.

The exact risk paths in retained rechecking rows are below. A and C never edit the zoo setup script or workflow in this scenario; both checks already see those accepted setup bytes. The paths come from the probes, rather than a newly installed check harness.

| Row | A path | C path | Why the existing rule refuses reuse | Assessment |
| --- | --- | --- | --- | --- |
| rust | `build.rs` | `crates/core/haystack.rs` | Root build script | Required combined check |
| mixed | `crates/jiter/build.rs` | `crates/fuzz/fuzz_targets/compare_skip.rs` | Nested Cargo build script | Required combined check |
| electron | `index.js` | `test.js` | Root configuration catch-all | Conservative rule covers ordinary root source; no retained stronger proof |
| swift | `Package.swift` | `Plugins/GenerateCommon/GeneratePlugin.swift` | Root package/build input | Required combined check |
| zig | `build.zig` | `clap/args.zig` | Root build input | Required combined check |
| history | `karma.conf-sauce.js` | `modules/_baseCreate.js` | Root configuration catch-all | Test configuration; required combined check |
| binaries | `ammo.h` | `bullet/src/Bullet-C-Api.h` | Root configuration catch-all | Conservative rule covers a source header; no retained stronger proof |

A disjoint path alone cannot prove the changed build script or configuration had no effect. The risk classifier is unchanged. Root source/header classification is broader than a semantic dependency proof would require; removing that catch-all without such proof would also remove coverage for unknown root check inputs.

The synthetic scheduler replay uses 1,000-tick checks: the conservative A/C path lands C at tick 2,035, against solo 1,005 and the unchanged 1.5× target of 1,507.5. The admission pipeline instead checks the exact A+C tree beside A and lands C at tick 1,033; if C finishes first it retains that pass until A lands. At 4,000 source files the same replay uses 104 transactions per pair instead of 121, with lower measured metadata reads/writes and no idle tasks. These are fixture measurements, not live Rust timings. A successful pair removes one solo check; invalidating a pending predecessor can waste an already executing follower's full-check duration before original-selection recovery. The existing pipeline width bounds that cost. Live verification and billed usage remain unverified here.

The import median has a separate cause. Eleven replacement rows exceed 1.5× their import baseline: JVM, mixed, C#, electron, Elixir, Swift, Android, C++, npmws, history and shapes-posix. Every one retains a `GITHUB_RATE_LIMIT` reset wait in the provider-wait table above. The qualified Rust target-import median is 76.660 s; its five walls are 76.660, 1,792.129, 13.946, 13.933 and 5,392.718 s. Those waits are elapsed time, including the final long wait, and cannot be replaced by active-attempt timings. The previously qualified JVM fresh-import median passes. Other import overruns remain singleton observations, not five-repeat qualifications. Import authorization/provider work remains on Issue `2abda01f`; queue scheduling does not fix it.

## Qualification scope

The five fresh matched Rust C overtakes establish that the strict timing bar is unmet. The numeric C baseline remains unchanged even though that baseline C landed first. This is a strict column miss with an execution-order mismatch, not causal proof of a code performance regression. The five Rust target-import wall times also exceed the import bar at their median because provider waits remain in elapsed time. The successful-attempt median is retained separately and never substitutes for the wall-time verdict.

Other import timing overruns with named provider waits are reported as observations, not additional qualified misses: five extra fresh-import repetitions per affected repository were not run. Once the overall strict bar was already conclusively unmet, the remaining authorized work prioritized all 26 functional rows and complete cleanup within 600 MB. Earlier five JVM imports remain reported. Public-metadata authorization before scoped App lookup is recorded on existing Issue `2abda01f`; that larger runtime/auth investigation was not implemented here.

The Dart row has a function-level DB-read increase that needs attribution on storeD Issue `8c4f126b`: `projectObjects:available` rose from 85,420 to 93,723 bytes per repository row (28,473.333 to 31,241 per landing, +9.72%), and `projectObjects:prepareBatch` from 91,975 to 101,250 (30,658.333 to 33,750 per landing, +10.08%). Both cohorts have 35 files, three landings and equal calls for these functions. These are full-function reads, with changed documents read and reversed A/C order; no isolated table-level or causal storeD verdict is claimed. The selected-function subtotal falling does not negate these increases.

## Local preflight coverage

The required scenario table does not claim that every inferred local preflight or every upstream test ran. Missing local Gradle, .NET, Flutter and uv toolchains are recorded as `TOOLCHAIN_MISSING` with deferred units. The inferred mixed/jiter Cargo command failed because its external `json-cases` corpus was absent; npm workspaces' inferred test command failed because generated `lib/main.spec.js` had not been built. These preparation/selection observations are recorded on existing Issue `537e73d9`; the electron missing-dependency case also has prior Issue `9ab983fd`. No failing local command was relabelled passed. The declared fixture check and its plain-GitHub comparison remain the hosted check being timed, rather than a claim about the entire upstream suite.

History also has an increased selected lookup subtotal: 1,549,066 → 1,690,543 DB-read bytes per repository scenario (+9.13%), or 516,355.333 → 563,514.333 bytes per landing, at 402 files and three landings in both cohorts. `projectConvexSourceObjects:resolve` reads 710,320 → 790,516 bytes despite 32 → 27 calls; `projectObjects:available` reads 384,948 → 405,213 and `prepareBatch` 392,439 → 413,190 with unchanged calls. Binaries has increased `available` (450,383 → 465,696) and `prepareBatch` (457,868 → 472,695) reads at 1,387 files and three landings. These observations are on the same storeD Issue. They establish observed increases in the later cohort; the missing old source SHA and other execution changes prevent a causal table-layout conclusion.

The suite orchestration now stops after a failed, interrupted or unready preparation, retaining its original journal instead of launching a fresh scenario import. Exact named hazard refusals are complete rows and are not repeated by the scenario stage. Healthy prepared rows run their unchanged scenario against the same project. This removes duplicate attempts without adding backend or idle calls.

An interrupted import identity is also retained in local state before the first backend request. A later run folder restores that same journal and operation rather than creating a new project; the full original elapsed wall time remains in its timing. Source changes under the retained identity fail explicitly. Intentional `--reimport` can create a fresh project after a terminal result. These changes add local metadata writes, with unchanged healthy backend calls and timing boundaries.

Teardown retires local terminal import pointers while reporting unfinished ones honestly. `suite run --reimport` prepares the fresh project before its metered scenario and does not import it again. Direct low-level reimports without prior preparation are labelled unmetered, never charged to an old project. No new backend surface or idle calls were added.

A source-representation refusal can occur before the import job exists. The shared journal now records the exact pre-job `projectGithubImport:start` / `GITHUB_SOURCE_UNSUPPORTED` rejection, allowing cleanup to retire that local pointer without inventing a job status. Unknown outcomes keep their original operation.

The packaging guard originally followed a dangling POSIX fixture symlink and failed with `ENOENT`. Its collector now uses `lstat` and excludes all symbolic links, matching [npm’s documented package contents](https://docs.npmjs.com/cli/v11/commands/npm-publish/#files-included-in-package). A deterministic fixture covers dangling, external-directory and cyclic links while retaining the real missing-helper and unbuilt-output guards. This removes incorrect traversal without benchmark-path exemptions. No package was published; private raw evidence is retained outside the package entry list. Issue `577ec62d` records the failure and fix.

Stored-job recovery sends only the endpoint’s original operation ID, URL, ref and name. The deployment remains in local journal identity and is excluded from the server payload; the existing recovery case checks the complete field set. This removes an invalid retry field without adding a backend call.

## Measured cost and cleanup

The project-attributed counters imply $0.2280 at the meter's listed rates. Separately observed owner-catalog calls and DB reads add $0.0089 in known charges; owner-only network egress and compute are not independently captured. The whole-date-window owner reserve implies $0.0451, conservatively budgeted but not attributed to this zoo run and potentially overlapping live observations. These are usage estimates, not an account invoice or an R2 cost estimate. Source-governance work for the harness fixes and recovery activity outside the tagged project windows were not independently attributed. The whole-date-window owner reserve is not asserted to cover every unmeasured class; the 1 MB diagnostic reserve covers the indexed recovery allowance, not all source-governance work.

Rates used: $2.2000 per million executions; $0.2200 per decimal GB of DB read+write; $0.1320 per GB network egress; $0.3000 per GB-hour action compute. The source meter is [scripts/bench-t3code/meter.mjs](../../scripts/bench-t3code/meter.mjs). The final conservative counter is 580.571 / 600 MB, including the 140.140693 MB date-window reserve and 1 MB diagnostic reserve.

| Cleanup phase | Confirmed / addressed projects | Project DB I/O MB | Observed owner-catalog read MB | Uncached owner queries | Owner read B per newly purged project | Wall seconds |
| --- | --- | --- | --- | --- | --- | --- |
| Early JVM | 7 / 7 | 3.918 | 9.871 | 99 | 1,410,177 | 1,691.083 |
| Completed repository projects during provider wait | 26 / 26; 25 newly requested | 34.531 | 18.225 | 180 | 728,980.88 | 3,086.812 |
| Final synthetic teardown | 23 confirmations, including prior tombstones | 4.578 | 7.784 | 82 | 1,556,884.8 | 1,537.334 |

The final paged owner-catalog audit found no active zoo projects and retained 41 completed purge tombstones among 41 known measured project identities (3 owner-catalog pages; no missing known IDs). Their recorded totals are 21,886 metadata rows / 21,671,680 logical metadata bytes, and 2,215 R2 objects / 452,715,807 R2 bytes. These are deletion receipts, not billed DB-I/O bytes. Already deleted projects are confirmations rather than new purges. All 26 disposable forks are absent after teardown. The old git-fidelity scratch root was removed after the run.

Cleanup owner-catalog figures conservatively include every observed deployment call in each window; the per-project values are batch amortizations, not direct import or landing charges. Initial forgotten-project and Go/Python cleanup is included in aggregate project usage where captured; their missing raw artifacts limit separate phase attribution. Final audit reads are included in the final aggregate counter.

## Run metrics and limits

Project coverage windows: 2026-11-10T20:39:20.736Z to 2026-11-10T22:41:40.072Z; 2026-11-10T23:22:18.300Z to 2026-11-11T06:52:02.182Z. Final offline validation reconciled 63 per-function read/write/egress totals and 21 imported source pins; named unmetered hazards: shapes-collide, shapes-nonutf8, shapes-unicode. Go/Python raw row loss remains the stated exception. No missing numeric fields were reported by the retained streams.

The first remaining-row driver spanned 00:26:12 to 04:21:05 UTC and reported 11,603.61 seconds with peak RSS 519,864,320 bytes. The clocks are retained as reported, rather than forced to agree. Orchestration was held from 03:39:36 to 04:00:31 while an unknown LFS import outcome was reconciled; the in-flight NPM preparation continued. Named provider waits and their durations remain in import walls. The six earlier generic fixes each passed a 955-file hosted landing check; two checks retried an archive-memory failure without weakening its guard. Their individual elapsed check minutes were not retained. Final local harness validation is 46 zoo cases, four packaging cases and three hook-bundle cases; full final verification and receipt are attached to the parent Issue by the accepting landing.

Saved overlap notices included the intentional B/A probe conflicts in scratch scenarios. Own source was behind the lead’s process-guard test correction and was integrated before final admission; the correction was not duplicated. Source fixes stayed in one Lane. Private measurement recovery and provider waits caused the reported rework; no unobserved performance gain, isolated storeD attribution or complete upstream-test claim is made.

Issue `70a9bd2f` remains open: the strict timing bar is unmet, broader owner-catalog polling cost (`c088b39e`), import authorization robustness (`2abda01f`), preflight preparation (`537e73d9`) and the observed catalog-read increases on storeD (`8c4f126b`) still need their recorded follow-ups. The published per-path report and on-demand measured-cost lines are met; this evidence does not close pending work.

Final local preflight exposed a second build-output issue: two hashed edit-hook chunks from successive builds remained in shared `dist`, failing the existing first-write bundle guard. Issue `45ea1862` records it. The hook bundler now retires only obsolete hashed hook chunks after a successful build, preserving current chunks and unrelated CLI/TypeScript outputs; failed builds keep the last successful graph. A synthetic rebuild in the existing bundle test verifies changed hashes, sibling preservation and failure recovery. The eager-loading byte ceiling remains unchanged. The CLI bundler already cleans its own separate namespace; no other shared-directory Vite builder was found. This removes stale generated files with no runtime or Convex work.
