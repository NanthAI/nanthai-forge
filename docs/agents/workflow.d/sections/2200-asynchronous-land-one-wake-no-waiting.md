### Asynchronous land: one wake, no waiting turns

In an agent client that wakes the agent when a background command exits (Claude
Code, or any client with `FORGE_AGENT_WAKE=background-exit`), hosted `land --save`
returns as soon as the landing is submitted. It prints
`land: SUBMITTED; it settles without you…` and its `result.wake.command`
is one settle wait with a 7,080 s budget:

```sh
nforge agent ROOT wait '{"operationIds":["ORIGINAL_UUID"],"until":"acceptance","timeoutSeconds":7080}'
```

Run it once as a background command (Claude Code: Bash `run_in_background` with
`timeout` 7200000). It holds the landing's live subscription, never polls, and exits
once, when the landing settles: landed, failed or cancelled, with the receipt and its
recovery. A note or a newly recorded exact-conflict notice to your Lane also ends it early
(`IN_PROGRESS`, reason `message`); read the notice and run the same command again. A shorter
background limit (Claude Code's default is 1,800 s) stops the wait with SIGTERM; it then returns
`IN_PROGRESS`, reason `stopped`, exit 3, with a note and the same command, and the landing goes on.
A closed shell (SIGHUP) does the same. A wait never exits 0 with unfinished work: an exit before its
reply (a drained event loop, a stray exit) prints `nforge wait ended before the work settled` with the
command to run again and exits non-zero, and a reply that says unfinished exits 3. An exit
that is not a terminal landing receipt is never "landed": exit 3 or `IN_PROGRESS` means run the same
command again; exit 2 (a failed landing, `SYNC_REQUIRED`) follows its printed recovery. Run that command again with the longer
timeout. Do not run `status` or `wait` in between. Then:

- If ending your turn ends your task (a delegated builder or sub-agent run), block on
  that background command with your harness's wait tool (for example T3 Code's
  `t3_background_wait`) instead of ending the turn.
- Otherwise end the turn or keep working; the command's exit wakes you.

The land command opens no observer, and the settle wait costs one subscription for
the landing's whole life instead of a fresh subscribe and reread every 540 s; Convex
calls per landing do not rise, and nothing runs while idle. `--wait` keeps the
foreground wait below; `FORGE_AGENT_WAKE=off` turns the asynchronous default off.
Codex and other clients without background wakes keep the foreground wait.

During a [measurement hold](../../../operations/cli-update.md), an explicit
`land --save --no-wait` returns a local receipt with the hold and a `waitCommand`.
The detached submitter uses the receipt's operation ID when the hold releases.
Run `waitCommand` on the same machine to follow the request through submission
and acceptance.
