## Overlap before the first write

The first successful command of the installed CLI installs Claude Code and Codex hooks, even with
`--ignore-scripts`. It prints changed files and the exact undo
command. Installation is idempotent, preserves other hooks/settings and resolves
the Lane from each edited path, covering every hosted/native Lane.

Hooks only ever point at the installed, auto-updated CLI (`forge-cli/current`). A
Lane, temp or dev build (`node dist/cli-entry.js`) never writes them, not even
`install-hooks`; it reports `dev-build` and changes nothing. An automatic run of the
installed CLI also leaves hooks that point at another valid install alone and only
repairs a missing target; the explicit `install-hooks` from the installed `nforge` takes
over. `nforge status ROOT` and `nforge doctor ROOT` show `hooks` and, for a missing,
unreadable or non-installed hook path, print the one repair command. `nforge doctor ROOT`
also takes a Forge clone or Lane checkout (no Git): it reports the CLI version, build
and Node, `hooks`, the checkout marker (project, head, Lane and base) and the recorded
address from local files only, with no network call or write.

```sh
nforge x ROOT uninstall-hooks '{}'                  # remove; persist user off
nforge x ROOT install-hooks '{}'                    # reinstall; user on
nforge settings firstWriteHooks false               # user off; true reverses
nforge x ROOT uninstall-hooks '{"scope":"project"}' # project off on this machine
nforge x ROOT install-hooks '{"scope":"project"}'   # reverse project off
```

Project switches use the hosted project ID, across its Lanes
on this machine. Both switches apply; preferences use `~/.config/forge/edit-hooks.json`.
`PreToolUse` covers Claude `Edit`, `Write`, `MultiEdit`, `NotebookEdit` and Codex
`apply_patch`, including move destinations. Shell writes and clients without
hooks remain outside coverage; clients may require their normal trust review.
Hooks live in the user settings files, so an agent host must load them: a Claude
Agent SDK host passes `settingSources` including `"user"` (Claude Code and Codex
CLIs load them by default). Hook commands run through the `current` symlink; every
Forge entry script compares real paths (`scripts/main-module.mjs`), and a build-failing
guard keeps it that way.

Hosted first writes carry no overlap notices (Issue 853fcde3). Once the server
advertised the board, each uncached hosted path/session makes exactly one bounded
`projectHostedOverlaps:read({projectId,laneId,path,board})` query using the existing
login, for board claims and unread notes only; otherwise the hook makes no call. Native hooks read selected
Lane headers, saved summaries and local claims. Neither path loads full Work or
source bytes. Lane identity reads only the local marker prefix.

The hook never denies edits or requires acknowledgement. Context is capped at
five notices/path and 1,800 characters/tool call. Overlaps and failures are cached
per Lane/path/session; repeats make zero calls and emit no cached private evidence.
A new session checks again. Idle calls, polling, per-item calls and hosted writes
are zero. Unreachable servers, invalid responses and deadlines report incomplete
coverage and continue. The supervisor fails open after one second, below the
client's two-second timeout; hosted RPCs abort after 650 ms. Failures go to stderr. Hosted first-write
delivery telemetry remains incomplete.

Hook observations add no save attribution. No transcripts or prompts are read. Delivery never
acknowledges; missing evidence never proves independence.
See [hosted advice](#hosted-overlap-advice) for start/save/status notices.

Client contracts: [Claude hooks](https://code.claude.com/docs/en/hooks) and
[Codex hooks](https://learn.chatgpt.com/docs/hooks).

Local source exclusions use nested `.gitignore` and `.forgeignore` files; Forge rules follow Git rules in each directory. `nforge status ROOT --ignored` reports local excluded paths and matching rules without their contents or remote calls. Ignored working files are not stored, backed up or shared; historical States remain intact. See [source exclusions](../../../operations.md#source-exclusions).

For temporary files and logs, use `.forge/scratch/` inside your Lane. `nforge status .` prints
its path. Create it when needed. Forge skips its contents on save and during conflict checks,
and preserves the folder when applying source locally. Keep work that should be saved in the source tree.

Coordination before the queue (hosted, Issue 1eb42254). When a peer that touches your saved files is admitted, the receipt's `stackOffer` (`{peerLaneId,mode,text,command}`; the CLI prints it on stderr) offers `nforge agent . sync '{"laneId":"YOURS","stackOn":"PEER"}'`: the sync merges the peer's pending head (not main) and your landing then waits for the peer's. It is refused with `STACK_PEER_NOT_LANDING` when the peer has no live landing and `STACK_ALREADY` on a Lane that is already stacked. With the project setting `agentDefaults.stacking:"auto"` the next plain `sync` stacks on the offered peer by itself (and falls back to a plain sync when the peer's landing has ended). If the peer's landing fails, `land --save` refuses with `STACK_PARENT_FAILED` and the one command to run: the next `sync` re-pins the Lane to main and keeps only its own changes, then the landing checks once. The finite overlap query skips peer evidence on ordinary receipts when an indexed lookup finds no ready landing. When a ready landing exists, it uses the same peer window and inspects at most three matching peers' landings. Explicit path and detail reads still return saved peer evidence. Conflict notices, presence and board notes use their existing reads.

Dormant Lanes (hosted). An open Lane with no record write for `agentDefaults.dormantAfterDays` (default 2) is dormant: overlap, presence, board and start reads skip it, and any save or start revives it. A Lane whose overlap row predates the activity field and has no presence time reads as live until its activity is known; each landing completion stamps up to five such rows from their Lane record, so they go dormant on time with no manual step or added read per save. `lanes {view:"dormant"}` lists them with `abandonable`; `nforge x ROOT abandon-dormant {}` dry-runs and `{apply:true}` abandons at most 25 landed (stamped, named by a receipt, or proven equal to main's bytes) or never-saved ones per call (see [parallel-work defaults](../../../parallel-work-defaults.md#dormantafterdays)).

Superseded Lanes and idle summaries (hosted, friction b7f93deb). When a Lane lands (completion tick), its other open, unpinned Lanes of the same Intent that were last written before it started are marked `superseded` on their overlap row, as is the conflicted original of a landed resolution Lane that was saved again after the conflict. A superseded Lane stays open with its saved work (nothing is abandoned or deleted); it leaves presence and advisory notices, and blocking notices from it stay. A new save or `start --reopen` makes it live again. Separately, the default `start`/`save`/`peers` read replaces the advisory notices of every open Lane idle more than 6 h with one summary item (`reason:"idle-lanes"`, at most 3 Lane ids, no answer needed); `detail` and `path` reads, and every blocking notice, still list each Lane. No extra calls: the marks are written inside the completion tick and the summary is computed over rows the read already holds. A resolution Lane gets no overlap notice about the Lane it resolves or that Lane's other resolutions, and Lanes of one stack (root, parents, children, siblings) get none about each other: the match is by exact Lane id stored on the overlap row (`resolutionOrigin`, `stackRoot`), so a moved head cannot break it; reads add no call. Replaced Lanes (Item d9e1ac62). When you open a new Lane for an Issue that already has an open Lane (a resolution of a conflicted Lane, or a fresh start; `start` lists them as `openLanes`), abandon the earlier one once yours carries the work: `nforge x ROOT abandon '{"laneId":"OLD","reason":"Replaced by Lane NEW"}'`. When `openLanes` holds an open resolution Lane beside the open Lane it resolves, the `start` reply (compact too) adds `replaced`: both Lane ids and that exact command, to run once the earlier Lane's work is confirmed in the resolution Lane. It is advice only (`start` never abandons anything) and comes from the Lane records the list already reads (feature `start-open-lanes-resolves`; older servers send no `resolves`, and no hint is guessed). Until then, a Lane quiet for 90 minutes beside a live Lane of the same Issue reads as replaced, and so does a Lane whose open resolution Lane exists, even when both are quiet (unless the conflicted Lane has a landing in flight): the web Lanes list groups Lanes of one Issue, shows each row's short Lane mark and Lane count first (a dense row cuts only the person), marks it "replaced by <Lane>" and sorts it below the live one, and `lanes {"view":"loose-ends"}` gives its row `replacedBy` and that abandon command as `next` (one Lane-head read per Issue in the read, plus one overlap-row read per listed quiet Lane of an Issue with several open Lanes; no extra call elsewhere). `lanes {}` names a resolution Lane's conflicted Lane as `resolves`, from the record it already reads.

Lane tree (Issue 57c6f3ec). `lanes {"view":"tree"}` returns the ordinary open-Lane page plus `tree`, compact text lines: stacked Lanes sit under the Lane they stack on, each line gives the Lane's short id, state (`new`, `saved`, `waiting`, `held`, `checking`, `ready`, `failed`, `landed`, with `dormant` appended), goal and next step, and an `overlaps:` line names the page's other Lanes that share saved paths (exact on the listed presence paths, `maybe` when only the path filter matches; Lanes of one stack never overlap). Each page row also carries `stackOn`, `held` and `overlaps`, the same data the web dependency graph reads. Cost: the same one query and page as `lanes {}`, plus one slim presence point read per listed Lane; no per-Lane call, no write, nothing when idle. A stack parent on another page is named, not fetched.

Pinned Lanes (hosted, owner only). `nforge x ROOT pin '{"laneId":"…"}'` (or `forge_task` `pin`) sets one optional flag on the Lane record, mirrored on its head row, so reads add no calls; `pinned:false` clears it. Any Lane state can be pinned, including a completed one, and `reopen` works on it. A pinned Lane is skipped by `complete-merged`, completeOnAccept, the Intent cascade (`abandon` with `cascade:true`), `nforge prune` and client cache GC; an explicit `complete` or `abandon` returns `LANE_PINNED` until it is unpinned. Pinning writes one new Lane version (head and source versions are unchanged); a repeat is a no-op. The client keeps a machine-local mirror in the Lane registry, refreshed by every applying prune read, so prune and cache GC keep the checkout even when the server is unreachable. Pin the Lanes whose roots must survive cleanup (the lead's own); there is no other protected list.

Lifecycle. When the project policy has `lifecycle.completeOnAccept:true`, accepting a Candidate (through `finish` or `accept`) marks its input Lanes `completed`, and their Intent when all its Lanes are completed, unless the request has `keepOpen:true`; the receipt lists them under `completed`. A Lane is `merged` (shown as `merged:true` and `mergedInto` in detailed `status`/`records` Lane items) when it has its own work and its head is an ancestor-or-equal of an accepted Channel head. Reading never changes records. `complete-merged` (`{"channel":"main"}`) explicitly completes every open merged Lane and the Intents whose Lanes are all completed, returns what it changed and does nothing on repeat. `complete` and `reopen` take `{"laneId"}` or `{"intentId"}` and need no revision. A native Lane changes state only along legal moves (active, paused and ready to each other or completed; completed and abandoned only reopen to active; a Lane still being created has none); anything else returns `LANE_STATE_INVALID` naming the legal moves, and repeating a state is a no-op. Hosted projects: completing a Lane (by `complete`, `completeOnAccept` or `complete-merged`) also completes its Intent when no other Lane of that Intent is still active, in the same step; a pinned or open sibling Lane keeps the Intent open, and with `completeOnAccept:false` nothing completes until you run `complete`. `complete {laneId}` closes one active Lane (a repeat is a no-op and a Lane that is not active is refused with `WORK_STALE`); `complete-merged {}` (project owner) completes every active Lane whose exact saved head an accepted receipt landed and that `completeOnAccept` did not already complete. It pages through accepted receipts, about 10 receipts or 100 Lane entries per call, and prints `{completed, calls}`; it is safe to repeat. `completeOnAccept` is on by default for new projects; an existing project turns it on with `set-policy`. Close on land (hosted, GitHub's `Closes #N`): a landing completes the Intent of every Lane it landed in the same completion tick, even when the Lane stays open (`completeOnAccept:false` or `keepOpen:true`), unless another Lane of that Intent is still open or pinned (a sibling that stayed open after its own landing and has not been saved since counts as landed, so Lanes that land one after another still complete the Intent); the next planning read then closes the Issue sharing that Intent id only when every Done-when line is ticked, otherwise it reports `held` (no auto-close with open lines): the open line count, the lines (`held[].lines`) and the exact close command (`held[].close`). `finish`/`land --save` take `closes:false` (GitHub `Refs #N`: the landing references the Intent without completing it, and like `keepOpen` it leaves the landed Lanes open, so the next edit in that checkout saves and lands without a new Lane; receipt `completion.enabled:false`); project policy `lifecycle.closeOnLand:"off"` (default `declared`) makes every landing refs-only. The receipt records the decision in `completion.closeIntents`; older receipts without it follow `completeOnAccept` as before. It adds no call beyond the existing completion tick (one Lane head-row read per landed Lane plus the Intent head and sibling page read, one record write). Lead and builder briefs do not hand-close Issues blindly: land, then read planning once; a closed Issue is done, a held one lists its open lines and the close command, so tick the lines or run that command once the evidence covers every line (never close with lines unmet). Older deployments return `HOSTED_ACTION_UNSUPPORTED`. Completion keeps all source and evidence and does not stop further edits. `clean` (dry run unless `{"apply":true}`) reclaims disk from finished check workspaces and completed Lanes' build dirs or fully captured directories; `reopen` restores a removed Lane (see [operations](../../../operations.md#local-cleanup)). With `lifecycle.cleanRegenerableCopies:true`, completion and abandonment automatically remove eligible reconstructable native Lane folders and report removals, skipped copies and restore instructions. Terminal remote checks also remove eligible `github-actions-source` copies (and legacy `modal-source` ones) immediately under this policy; receipts, logs, selection, plans and artifacts remain. Terminal native check workspace cleanup retains its existing behavior; when the cleanup policy is enabled it records a separate automatic-action outcome after evidence is durable, without changing the run receipt. Policy-off cleanup preserves the Work format. `DISK_LOW` refusals retain materialized workspace and runtime files even during later automatic sweeps.

`records` returns the same page as `status` sections (`items`, `total`, `more`, `nextOffset`, plus the older `records`). Filters: `state` or `status` (for example `{"collection":"lanes","state":"active"}`) and `merged:false|true` for Lanes; filtered offsets index the filtered list. `observe`, `log` and `cancel` take the nested check run operation ID, not the finish ID. Resume an admitted finish with the receipt's `waitCommand` on the original parent operation id. Before admission, replay its original request plus `resolved` pins. A failed `run`, `observe` or `finish` receipt carries `failureSummary`, and `log` accepts `tail:BYTES` (up to 65536) to read the end of a stream. On a hosted project, `log {runId,tail?,stream?,shard?,attempt?,json?}` prints the retained, redacted tail of a hosted check run (default 8192 bytes, at most 64 KiB, which is all Forge keeps per job; the full log stays with the provider, whose link `log` prints) with the run's own access rules, so no `gh run view --log` or runner-repository login is needed. `runId` comes from `status`, `observe` or `wait`. While the check is still running, `log` returns the lines its runner has published so far: each stream not yet sealed is marked `live` (the reply's `live` is true and the CLI line names the running shards). Run it again for newer lines; nothing is pushed or polled, and a run nobody reads costs no calls. `run` accepts `{"laneId"}` instead of `viewId` (the Lane's latest clean Candidate) and defaults the check as `finish` does, so repeating a flaky check is one short command.

Select a check from `check-settings`, or use `nforge x ROOT configure-check` with `{"command":{"name":"verify","executable":"npm","args":["run","verify"],"environmentLabel":"clean"}}`. Checks run in a fresh exact-Candidate directory, so the command must prepare its dependencies. `run` takes `viewId` or `laneId` (and optional pins) and waits by default; `observe`, `log` and `cancel` address that run. For the standard Forge check, `run {"laneId":"…","tests":["tests/a.test.mjs"]}` (or `viewId`) replaces only the selected test files; static checks still run. For any other check, the list names the [project test runner's](../../../parallel-work-defaults.md) files at that head (for example `packages/a/src/sum.test.ts`), and the local runner runs exactly those with the runner command instead of the check command; a project that checks on a remote runner, a file the runner does not match, or a project without a runner is refused with `BAD_ARGUMENT`. An explicit list, including `[]`, is retained as `checkSelection.scope:"partial"` and uses at least Work format 15 so readers without selection evidence refuse it. It cannot satisfy an automatic acceptance gate, an Invariant check requirement or check reuse; use ordinary `finish` for landing evidence. Retry with the same operation ID and the original list to observe the existing execution.

`accept` takes `viewId`; `channel` defaults to `main` and `expectedPrevious` to its current head. Invariants, releases, Playbooks, human reviews and GitHub publication keep their existing owners.

Once hosted holds source authority (`server` mode, or a pending switch to it),
local `accept` and `accept-channel` return `HOSTED_AUTHORITY`, whatever the owner
role or local autonomy policy. The error names the hosted project and an
explicitly addressed `nforge agent ROOT finish` command for the hosted landing
queue. Review and accept on the hosted project page, or submit a hosted Lane with
`{"url":"DEPLOYMENT_URL","projectId":"PROJECT_ID","laneId":"HOSTED_LANE_ID","accept":true}`.
There is no local override: if hosted is unavailable, landing pauses
and editing continues.

For hosted Lanes, the same `nforge mcp ROOT --agent` detects the hosted checkout or
retained CLI address; `--url URL --project-id ID` selects a new hosted address.
Task/check/overview commands reuse the hosted CLI schemas and retry journal.
Source tools return saved Lane/State/blob pins and accept optional exact expected
pins; local drafts are separate. `forge_check` observe is finite; only an explicit
`forge_wait {runId,timeoutSeconds?}` subscribes live, and closes on every exit.
Account credentials still request agent acceptance under current policy. See the
[hosted CLI and MCP contract](../../../operations/source-exchange.md#hosted-agent-cli-and-mcp).

Hosted source replies distinguish `submitted`, `retryable` and `failed`. A failed
scheduled worker step returns `SOURCE_WORKER_STEP_FAILED`; a job with no progress
past its worker lease returns `SOURCE_JOB_STALLED`. `SOURCE_PUBLICATION_STALLED`
identifies completed source whose publication needs reconciliation. These include `failedPhase`
and the retained job ID. Save, compose, sync and resolve replies include an exact
`replay.command` with the original action, parameters and operation ID, including
when finish is waiting on a source child. A retryable reply's `command` replays
that operation to reconcile the same execution and cursor. Terminal failures
retain the original receipt; their `command` starts a separately identified retry.
Progress reads never schedule work or renew leases. An active source wait returns
a stopped job immediately and uses the latest observed lease at its deadline,
so a dead job is not reported as merely submitted after sixty seconds.

For fresh context, read the linked Issue with `planning {id,reconcile:false}`, Lane `status` and the repo instructions.
