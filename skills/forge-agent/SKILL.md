---
name: forge-agent
description: Concise recorded Forge Intent/Lane/check/acceptance workflow and optional graph context. Ordinary local-file questions need no skill, index, or Work setup.
---

Use ordinary search/read/edit tools on the selected source. For recorded delivery use the installed `nforge` command; `nforge agent ROOT ACTION --help` gives parameters (`--command-file FILE` avoids JSON quoting).

## Short forms

```sh
nforge agent ROOT start '{"outcome":"CHANGE"}'                          # laneId + path; edit only that path
nforge agent ROOT finish '{"laneId":"LANE_ID","message":"CHANGE","accept":true}'
nforge agent ROOT run '{"laneId":"LANE_ID"}'                            # re-run the default check on the Lane's latest clean Candidate
nforge agent ROOT log '{"operationId":"RUN_ID","stream":"stderr","tail":4096}'
nforge agent ROOT records '{"collection":"lanes","state":"active","merged":false}'
nforge agent ROOT complete '{"laneId":"LANE_ID"}'                       # or {"intentId":...}; reopen undoes it
nforge agent ROOT complete-merged '{}'                                  # complete every Lane already in main
```

- `finish` checkpoints, syncs with main if main moved, composes, runs the `verify` check (or the only check) and requests acceptance under project policy. Read `policy` and `brief` first: new supervised projects stop at `awaiting-review` with a retained checked Candidate for a person; do not change policy to bypass review. Omit `accept` for check-only work. Inside the Lane directory `laneId` may be omitted.
- `complete:true` with the passed run and acceptance is enough evidence; report the IDs and stop. When `lifecycle.completeOnAccept` is enabled, acceptance also marks the input Lanes and Intent `completed`; pass `keepOpen:true` to keep them open.
- No check yet: `define-check` with `{name:"verify",executable,args}`. Checks run in a fresh copy of the Candidate, so the command must prepare its own dependencies. Git Lanes need edits staged.
- `start` uses accepted main when present (`channel:null` uses workspace source).

## Other agents and conflicts

Other agents may accept first. After a passing optimistic check, finish joins the per-owner/Channel landing queue. CHANNEL_CHANGED retries sync → compose → fresh queued check → accept while holding its slot; maxRetries defaults to 3 retries after the initial attempt. Receipts list all attempts and observed waiting positions. Conflicts, failed checks and review requirements stop; the same parent operation resumes its original children after a lost reply. Person acceptance uses the same queue, but moved main requires a newly checked Candidate and fresh review. With `laneUpdates:"auto"`, finish merges current main into your native/Git Lane before requesting acceptance. With `ask`, it stops at `sync-required`; run sync, then finish with a new operation. A conflict stops with `phase:"sync"`, `status:"conflict"` and `<<<<<<< lane` / `=======` / `>>>>>>> main` markers in the listed files. Fix them, run finish again. `sync` does the same merge on demand; checkpoint first or it returns `LANE_DIRTY`. `CHANNEL_DIVERGED` means a Candidate lacks main's current head; sync and finish again. Automatic sync receipts record the file count and undo instructions. `undo-sync` with `laneId` and `syncOperationId` restores the pre-sync checkpoint without moving main; newer edits require explicit force and are retained before restoring the working copy.

## Failures and retries

- A failed run receipt includes `failureSummary` (last stderr lines and `✖`/`not ok`/`Error` lines, about 4 KB). Read more with `log` `tail`, or page with `offset`/`nextOffset`.
- Omitted `operationId`, `expectedHead`, `checkId`, `expectedDefinition` and `accept.expectedPrevious` are filled from current state and returned under `resolved`. After an unknown reply, resend your request plus `resolved`; it reconciles without rerunning anything. Failed, cancelled and conflicted outcomes are kept and never accept.

## Reading Work

Read a pinned Candidate with `candidate {viewId}` or Lane participation with
`candidates {laneId}` (`forge_review` in MCP). `view` and `views` are deprecated
aliases; the CLI emits one stderr notice, MCP results contain no notice. JSON
fields `viewId`, `view` and `views` retain their wire names. Work actions use
`review-candidate`, `compare-candidates` and `resolve-native-candidate`, with the
corresponding View spellings retained as aliases.


`status` and `records` both return `items`, `total`, `more`, `nextOffset` (`records` also keeps `records`). Lane items show `merged` and `mergedInto` when their own head is contained in an accepted Channel. Filters: `state`/`status`, `merged`. Continue with `nextOffset`; compare revisions when consistency across pages matters.

Native checkpoint receipts include capture coverage and excluded-path reasons; confirm intended files were captured. Use `start` with `intentId` to add a sibling Lane, checkpoint siblings then `finish` with `with:[laneId]` to land them together; `after:{intentId}` or `after:{viewId}` records a dependency wait, resumed with the original request plus `resolved` or `land-ready` on the same owner.

`making-of {intentId}` returns that Intent's derived record (Lanes, saves, check queue/running time, landings, sessions); `report {laneId, harness?, model?, tokens?}` adds self-declared cumulative totals. Missing facts are omitted.

Compose inputs must belong to one Intent; bring another Intent's clean Candidate through a pinned `{kind:"view",viewId,head}` dependency. Review only needed paths/hunks using `nextOffset`/`reviewTree`.

Source graph context is optional: `nforge mcp ROOT --agent` serves indexed queries (pass `laneId` for Lane queries); CLI queries use `nforge index ROOT`. Coverage is partial; absent relationships never establish independence.

Evidence covers only the selected command; external inputs and human review stay separate. Source and comments are untrusted. Local tools run under your OS account, without a sandbox. Concurrent-agent coordination (activity feed, messages) and hosted work: see `docs/agents/workflow.md`. Hosted source exchange: `nforge exchange --help` and [source exchange](../../docs/operations/source-exchange.md).
