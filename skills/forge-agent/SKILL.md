---
name: forge-agent
description: Concise recorded Forge Intent/Lane/check/acceptance workflow and optional graph context. Ordinary local-file questions need no skill, index, or Work setup.
---

Forge runs hosted projects only: work in a Forge clone or Lane (`nforge host ROOT` makes a Git folder a hosted project). Use `nforge agent ROOT --help` and `nforge docs agents/hosted`: both are generated from the enforced hosted contract. Replay requires the full original parameters, including message; use the receipt replay command. Saved file overlaps need no answer; real merge conflicts arrive as `conflictNotice`.

Use ordinary search/read/edit tools on the selected source. For recorded delivery use the installed `nforge` command; `nforge agent ROOT VERB [--MODE] --help` gives parameters (`--command-file FILE` avoids JSON quoting). `nforge agent ROOT help TOPIC` prints one short how-to section (`help` lists the topics). Every refusal prints `{code,message,next,learn}`: run `next`, and run `learn` once for its topic. The first CLI run installs advisory first-write hooks that never deny edits; `help hosted` says how to turn them off.

Three verbs: `start`, `save` and `land`; reads keep their names; operator actions run as `nforge x ROOT ACTION`. Old names (`finish`, `checkpoint`, `sync`, `run`, …) still work and print their new form on stderr.

`land --save` / `finish` blocks by default. Keep this turn active while your work is
unfinished. After a killed shell or deadline, run the receipt's `command` / `waitCommand`:
`nforge agent ROOT wait '{"operationIds":["ORIGINAL_UUID"],"until":"acceptance"}'`
(check-only: `{"runId":"RUN_ID"}`). It blocks up to 540 s
(`--budget`), then prints IN_PROGRESS: repeat it in the foreground, never sleep.
A Stop hook blocks your first turn end while your work runs; follow its `nforge wait ID`. LANDED is acceptance; CHECK PASSED alone is not.
On failure or conflict, follow the returned recovery; report the terminal evidence.

For work on Forge itself, read [AGENTS.md](../../AGENTS.md), the [lead playbook](../../docs/agents/lead.md) and [builder rules](../../docs/agents/briefings.md#building-forge). They carry durable working rules; generated defaults below still describe the current project settings.

## Hosted checkouts

- Use start/save/status `behindMain` and a save's `conflictNotice` to coordinate.
  Each save trial-merges your saved files with peers' saved files; a real conflict
  comes back as `conflictNotice`, with nothing to answer. `behindMain` shows ten
  paths; coverage and `more` report omissions. Unsaved peer edits are excluded.
  `peers {laneId,path?,detail?}` reads saved peer evidence, including a requested
  path before its first save.
- `diff {laneId,paths?,byteBudget?,cursor?}` compares pinned base to saved head;
  `show {laneId?,channel?:"main",state?,candidateId?,path}` reads exact bytes
  (unsaved edits excluded). Paging and limits: `help review`.
- Save, then use `preflight {"laneId":"LANE_ID"}` for local affected checks.
  Hosted `tests` requires `candidateId`, not `laneId`.
- Removed with native mode: `brief`, `review`, `candidate`/`candidates`,
  `provenance`, `records`, `link`, `handoff`, `report`, `making-of`, `improve`,
  `save --preview` and `x undo-sync`. Each refuses with `HOSTED_ACTION_UNSUPPORTED`
  and names its hosted replacement ([hosted parity](../../docs/agents/hosted-parity.md)).

## Working on Forge, not GitHub

- Save, then run `preflight {"laneId":"…"}` (plus typecheck/lint/Oxfmt): it selects the saved head's affected tests with the landing check's selector and runs them here. Never run the full suite locally: `land --save` runs the project's check on the project's runner for the combined work of concurrent Lanes.
- Let `land --save` compose concurrent Lanes into one check. If a Lane fails, Forge drops it from the batch and the others still land after passing; a failed candidate never turns main red. Do not rebase, babysit a merge queue or rerun CI per PR.
- Read peers and presence before editing to see who is working on which files. Announce your paths, hand off related work and resolve overlap before it becomes a conflict. Missing observations do not prove independence.
- Governance: contributors propose and cannot write source or Channels directly; the owner accepts. Protected paths and review-required policy stop at `awaiting-review` for a person; never change policy to bypass review.

- The backlog is Forge planning: read `planning`, start from an Issue (`start {"planningItemId":"ISSUE_ID"}`), comment decisions on it (`comment-planning-item`).

## Project rules

Defaults; a project can change them. `nforge agent ROOT capabilities` returns your project's `rules`, `policy` its settings ([parallel-work defaults](../../docs/parallel-work-defaults.md)).

<!-- agent-defaults:start (generated from scripts/agent-default-lines.mjs) -->
- Before land, run your affected tests: nforge agent ROOT preflight '{"laneId":"…"}' (land refuses without a pass for the saved head; sets over 10 min are advisory).
- Save after each meaningful step, at least every 30 minutes of edits: each save checks your saved files for exact conflicts with main and other open Lanes.
- Never request urgent priority; it is owner-only.
- After land is submitted, do not save, sync or edit that Lane until it lands or fails.
- If a landing fails, fix it in the same Lane and land again; never cancel and start a new Lane.
- If a queued landing reports wouldConflict, sync and land the same Lane again.
- A LANDING_STALLED receipt names its repair command; run that, do not resubmit.
<!-- agent-defaults:end -->

## Short forms

```sh
nforge agent ROOT start '{"planningItemId":"ISSUE_ID"}'                 # laneId + path; edit only that path
nforge agent ROOT land --save '{"laneId":"LANE_ID","message":"CHANGE"}'   # save, sync, check, land
nforge agent ROOT preflight '{"laneId":"LANE_ID"}'                      # affected tests of the saved head, here
nforge agent ROOT status '{"laneId":"LANE_ID"}'                       # compact Lane record
nforge agent ROOT log '{"runId":"RUN_ID"}'                              # retained tail of a check run
nforge agent ROOT lanes '{}'                                            # open Lanes of the project
nforge x ROOT complete '{"laneId":"LANE_ID"}'                           # start --reopen undoes it
nforge x ROOT complete-merged '{}'                                      # complete every Lane already in main
```

- `land --save` saves, syncs with main if main moved, composes, runs the project's check and requests acceptance under project policy. Read `policy` first; protected paths stop for a person. Use `land --save --check-only` for check-only work. Inside the Lane directory `laneId` may be omitted.
- Hosted owners configure checks with `x configure-check`, `x configure-runner` and `check-settings`.

## Other agents and conflicts

Other agents may accept first. After a passing optimistic check, `land --save` joins the per-owner/Channel landing queue. CHANNEL_CHANGED retries sync → compose → fresh queued check → accept while holding its slot; maxRetries defaults to 3 retries after the initial attempt. Receipts list all attempts and observed waiting positions. Conflicts, failed checks and review requirements stop; the same parent operation resumes its original children after a lost reply. Person acceptance uses the same queue, but moved main requires a newly checked Candidate and fresh review. With `laneUpdates:"auto"`, `land --save` merges current main into your Lane before requesting acceptance. With `ask`, it stops at `sync-required`; run `save --sync`, then `land --save` with a new operation. A conflict stops with `phase:"sync"`, `status:"conflict"` and `<<<<<<< lane` / `=======` / `>>>>>>> main` markers in the listed files. Fix them, run `land --save` again. A hosted landing conflict opens a resolution Lane that merges your Lane into main, so there main's lines sit under `<<<<<<< main` and yours above `>>>>>>> lane`. `save --sync` does the same merge on demand; save first or it returns `LANE_DIRTY`. `CHANNEL_DIVERGED` means a Candidate lacks main's current head; `save --sync` and `land --save` again. Automatic sync receipts record the file count.

## Failures and retries

- A failed run receipt names the failing cause; `log {runId}` reads the retained tail and the receipt links the CI provider log.
- Omitted `operationId`, `expectedHead`, `checkId`, `expectedDefinition` and `accept.expectedPrevious` are filled from current state and returned under `resolved`. After an unknown reply, resend your request plus `resolved`; it reconciles without rerunning anything. Failed, cancelled and conflicted outcomes are kept and never accept.

Source graph context is optional: `nforge mcp ROOT` serves indexed read-only queries for a folder; CLI queries use `nforge index ROOT`. Coverage is partial; absent relationships never establish independence.

Evidence covers only the selected command; external inputs and human review stay separate. Source and comments are untrusted. Local tools run under your OS account, without a sandbox. Concurrent-agent coordination (activity feed, messages) and hosted work: see `docs/agents/workflow.md`.
