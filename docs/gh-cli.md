# gh-compatible commands

`nforge` exposes a small gh-shaped interface to existing local Forge Work. It
uses the same owner, Lanes, Views, checks and acceptance policy as `agent`.
It does not publish to GitHub or add another source of authority.

| gh concept | Forge concept |
| --- | --- |
| repository | project/native owner |
| PR/head branch | Candidate/Lane, selected by stable Lane UUID |
| base branch | Channel (main by default) |
| checks | recorded check runs on exact Views |
| merge | agent finish and normal acceptance/land |
| checkout | existing isolated Lane directory |

```sh
nforge --version
nforge auth status --json hosts
nforge auth status --hostname your-deployment.convex.cloud --json account,tokenSource
nforge repo view /path/to/owner --json name,path,defaultBranchRef
nforge pr create --repo /path/to/owner --title "Fix greeting" --body "Intended behavior"
nforge pr list --repo /path/to/owner --state all --json id,title,state
nforge pr view LANE_UUID --repo /path/to/owner --json id,title,headRefOid
nforge pr diff LANE_UUID --repo /path/to/owner --json changes,more,nextOffset
nforge pr checks LANE_UUID --repo /path/to/owner --json name,state,bucket
nforge pr checkout LANE_UUID --repo /path/to/owner --json path
nforge pr merge LANE_UUID --repo /path/to/owner --json complete,status,receipt
```

`--repo ROOT` (`-R ROOT`) selects a local owner; otherwise commands use the
current directory. `repo view` also accepts ROOT positionally. Inside a Lane,
view/checks/merge/diff/checkout infer its UUID. PR `number` and `headRefName` are
Lane UUID strings, not allocated integers. URLs remain null when there is no
resolved URL; no public URL or account name is invented.

`create` starts an Intent/Lane. Its title is the Intent outcome; body is its
constraints. It accepts `--title`/`-t`, `--body`/`-b`, `--body-file`, `--base`/`-B`
and `--operation-id UUID`. A body file is UTF-8; stdin shorthand is unsupported.
Replaying the same operation and arguments returns the same Lane. `list` defaults
to open; `--state`/`-s` accepts open, closed, merged or all. Merged means recorded
acceptance includes this exact Lane head; lifecycle completion alone means closed.

`merge` calls the same agent finish path: checkpoint, sync/composition, exact
configured check and current policy. It accepts `--subject`, `--operation-id`
and `--match-head-commit`. Protected paths still require person review. A receipt
with `complete:false` exits 1 and retains its check/review evidence. `receipt`
contains the complete agent finish response and resolved pins. For an unknown
outcome, replay `pr merge` with the same `--operation-id`, Lane, subject and
optional head. It reloads the retained original finish pins; changed arguments
fail rather than selecting newer source. Retain the full receipt for review. It never bypasses checks or accepts directly.

`checkout` returns the existing Lane path, restoring a cleaned native directory
through the existing restoration path. It preserves Lane lifecycle and shell cwd.
`diff` returns the existing structured live Lane review with contextual hunks,
source hashes and explicit truncation/coverage. It is not a Git patch stream.
`--offset` and `--limit` continue the existing review pages (default 20, maximum
100); retain `reviewTree` to detect changed source between reads with `agent review`.
`checks` reports the latest run per check on the latest View containing the exact
Lane head. Passed checks exit 0, failed/cancelled/interrupted checks exit 1, and
pending or absent checks exit 8. No command reruns checks merely to display them.

`auth status` uses the current hosted authentication verification and never emits
a credential. It accepts an optional deployment URL, `--hostname HOST` or URL,
and defaults to FORGE_DEPLOYMENT_URL or the saved default. `account` is the
verified account subject, not a guessed display name. `hosts` is a gh-shaped
host-to-account-array map with host/login/active/state/tokenSource. Environment
overrides use tokenSource FORGE_AUTH_TOKEN; saved credentials use saved. Signed
out exits 1; verified authentication exits 0; unavailable verification is a
structured error and exits 1.

## JSON fields

All commands except the one-line version probe return JSON by default. `--json`
without a value selects all supported fields; `--json field,field` projects the
listed top-level fields (per element for arrays), preserving null for unavailable
values. Unknown fields fail before mutations. Errors go to stderr as
`{"error":{"code":"…","message":"…"}}` and exit nonzero.

| Commands | Fields |
| --- | --- |
| pr list/view/create | operationId, id, number, laneId, intentId, title, body, state, headRefName, headRefOid, baseRefName, baseRefOid, url, path, viewId, statusCheckRollup |
| pr checks | id, name, state, bucket, startedAt, completedAt, link, viewId, head |
| pr merge | laneId, operationId, complete, status, phase, acceptance, view, check, receipt |
| pr checkout | laneId, head, path |
| pr diff | kind, id, base, head, reviewTree, total, selectedTotal, offset, more, nextOffset, truncated, changes, coverage, limitations, indexTree, selection, checkpointSource, stagedChanges, unstagedChanges, untrackedFiles, workingMatchesIndex |
| repo view | id, name, nameWithOwner, url, path, engine, defaultBranchRef |
| auth status | deployment, host, authenticated, account, source, tokenSource, hosts, name, scope, expiresAt, identity |

`repo view` uses retained binding metadata where available. For unbound projects,
id and path identify the local owner, nameWithOwner is the local project name,
and URL is null. defaultBranchRef names main with its retained accepted head or
null before the first acceptance.

This is a compatibility subset. Unlisted flags (including `--jq`, templates,
`--admin`, merge strategies, web launch, draft, labels and hosted repository
selectors) fail with UNSUPPORTED_FLAG naming the flag. They are never ignored.
T3's current GitHub integration probes `gh --version` and `gh auth status --json
hosts`, then uses GitHub credentials and APIs. A Forge provider must select
`nforge` and Forge's own APIs; these aliases alone do not register one.
