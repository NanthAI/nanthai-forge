### Turn-end guard

The first-write hooks also install a turn-end guard: a Claude Code and a Codex
`Stop` hook, plus an Antigravity `Stop` hook installed by `nforge connect antigravity`
(`~/.gemini/config/hooks.json`, replying `decision: "continue"` on a normal first stop
and `{}` on cancel/error/limit stops or on the second stop). Landings, check runs and waits that an agent session starts are
recorded in a local ledger, keyed by a digest of the client session id
(`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, `T3CODE_THREAD_ID`, or the Antigravity ancestor process). While one still runs, the first
stop attempt is blocked: "Your landing ID is still running. Run: nforge wait ID.
To stop anyway, stop again." The next attempt is always allowed. In a client with
background wakes the message instead names the one background settle wait
(`nforge wait ID --budget 7080`) or, when that wait is already running, says to block on it
with the harness wait tool if ending the turn ends the task, else stop again. With
`FORGE_AGENT_WAKE=background-exit` (the owner says turn end never ends the task) a live
settle wait covers the stop and the hook allows it. After a Forge
wait, the next stop counts as a first attempt again. `nforge wait ID [--budget S]`
runs the canonical wait for that session's recorded work; a full operation id it did not
record (a save, or work from another shell) runs `nforge agent . wait '{"operationIds":[ID]}'`. Each stop costs one
local read. A hosted query runs only when no live or recent (30 s) observation
exists. Idle costs nothing, and any failure allows the stop, including a hosted query that
cannot confirm the work (no hosted address, an error or its 2.5 s deadline). Entries whose
Lane folder is gone, or whose observer is dead and last observed over an hour ago (the
landing queue's own drop window), are pruned by that same local read and never block. An observer is the
recorded process id plus its start time, so a reused process id is not a live observer. `land --withdraw` and
`cancel` settle the entry of the landing they end. Work without a
session id, and non-Forge background processes, are not covered. Turn it off with
`nforge settings firstWriteHooks false`.

Codex gap (Item 2f13b3cf). The guard is proven with synthetic homes and real hook
processes, not yet in a live Codex session: nobody has observed `CODEX_THREAD_ID`
reaching the shell commands a Codex agent runs, or Codex's `Stop` hook honouring
`decision: "block"`. Without the variable the CLI records no turn work, and the hook
allows the stop. So Codex agents must not rely on the guard: after `land --save`, run
the printed `waitCommand` in the foreground. Never end the turn on a wait timeout.
Run the command again until you have a receipt or a refusal. Claude Code sets
`CLAUDE_CODE_SESSION_ID` in the shells its agents run, so the guard covers them.

Native waits can also select latest Lane work or several operations:

```sh
nforge agent OWNER wait '{"laneIds":["LANE_ID"],"operationIds":["OPERATION_ID"],"until":"terminal"}'
```

NDJSON contains initial observations, changed source/check/shard/overlap states
and a final summary; `--text` prints readable lines. Duplicates are suppressed,
settled targets stop emitting, and snapshots can coalesce fast changes.
`until:"any-change"` waits for a change from the baseline. Default `terminal`
waits for every target; unknown IDs, review and dependency waits remain pending.
Completed Lanes and landed/passed operations succeed; failed/interrupted checks,
conflicts, abandonment and supersession do not. A kept-open Lane can report its
saved head landed. Operations follow their original head and historical outcome;
a later save can report superseded without crediting newer work or cancelling
that original request. A passed Lane check alone never establishes landing.

Exit 0 means terminal (including failure), or an observed `any-change`; native
timeout is 2, cancellation 130. Hosted timeout is 3 / IN PROGRESS with its exact
continuation and, for an observed single landing, the `waitOutcome` described in
[Foreground wait](#foreground-wait). Transient observation failures retry until that deadline. Invalid
input/unreadable metadata exits nonzero. Inspect summary `successful` and target
`ok` for success. Failures retain reasons, infrastructure/check classification and
available log paths. Composition conflicts return exact `sync`/`resolve` recovery,
without a finish replay to discover it.

Submission events retain `submissionId`, `attemptId`, immutable `head`,
`attemptHead`, `state`, `outcome`, `pendingReason` and `cause`. Pending reasons:
`queued`, `checking`, `waiting-for-review`, `waiting-for-dependency`. Failure causes:
`conflict`, `check-failed`, `infra`, `stale-head`, `rejected`. Failed/interrupted
runs retain run/log pins before the final receipt. Operations settle independently;
batch cumulative/diagnostic prefix runs remain observable while diagnosis decides
which submissions land or fail.

A pending landing held by `waiting-for-review` (a person must accept it, for example
for protected paths) or `waiting-for-dependency` is not lost and not queued to land.
The current landing observation includes `approver` and `url` when available while it
waits for the owner. `land` and `wait` name the hold, print the owner's public
Forge handle when configured and give the approval link when the deployment has
a web address. Their JSON and `status`/`observe` on the operation carry
`hold {kind,reason,paths,next,review?}`, with `review {approver?,url?}`. `paths` lists the protected paths named
by the reason, or null. In a Lane checkout, `nforge status ROOT` checks the
locally recorded in-flight operation and prints its current approval details.
It uses the operation read in place of the overlap read, with no extra call. `queue` keeps held entries after the dispatch
order with `position:null` and `hold`, counts them in `held`, and never makes one a
predecessor; `yourLane` shows the hold. A `dependency` hold's entry also carries
`dependsOn {submissionId}`, the landing it lands after, from the finish record the
read already loads. `status {laneId}` shows `local.landingHold`,
the hold this machine's last `land` or `wait` saw (one local file, no call). A review
hold does not time out and an agent cannot release it: tell the owner, or withdraw.
A landing parked because main's full check is red (`MAIN_RED`) is the `main-red`
hold: `land`/`wait` print `HELD: MAIN IS RED`, `queue` shows it with
`position:null` (no queue position while held) and counts it in `held`. It resumes
by itself when main is green again; nothing to do in the Lane, never withdraw.

Every `land`, `wait` and `finish` reply, `queue` entry and native `wait`
submission also carries `landingState {state,label,nextStep}` (additive; existing
fields are unchanged); the compact wait line carries only the state name as
`landingState`. `state` is one of `queued`, `checking`,
`waiting-for-runner`, `landing`, `waiting-for-order` (passed, parked behind the older
submission its `nextStep` names), `held-review`, `held-dependency`, `held-main-red`,
`landed`, `conflict`, `check-failed`, `not-run`, `cancelled`, `stale-head`,
`rejected`, `superseded` or `unknown`; `label` is the word the web shows for the
same state (stale-head and rejected both read `Not landed`) and `nextStep` the same
sentence. `finish {stage:"inputs"}` on a superseded or withdrawn landing returns its
entry with `state:"superseded"` (outcome `terminal-failed`, cause `stale-head`)
instead of failing.

A landing whose check did not pass (`check-failed`, `not-run`,
`waiting-for-runner`, `held-main-red`, `stale-head`) also carries `failureCause`
on `status {submissionId}` and on the `land`/`wait` reply (in `submissions[]`):
`{cause, sentence, recovery, next, retryReason?, mainFailingSince?, suspects}`, the
same reading the web's Failed check screen shows. `cause` is `change`, `flaky-test`,
`main-failing`, `main-moved`, `ci-not-started`, `ci-stopped` or `unknown`;
`recovery` is `fix-in-lane`, `retry` (replay `land --save` with `"retry":true` and
`"reason"` set to the given `retryReason`; land also takes it as `retryReason`), `wait-for-main`, `wait` or `read-log`; `suspects` judges
the change, the test, main and your CI. Forge never guesses: an unknown cause says
so. Other states carry no `failureCause` and read nothing extra for it. When a reply
carries `failureCause`, `landingState.nextStep` is its `next`, so the reply gives one
next step. For `wait-for-main` on a failed landing that does not wait by itself,
`wait {"main":"green"}` holds one subscription to main's audit row and returns once
main is green (at once when it already is); then run `land --save` again.

Every JSON event/summary has a `cursor`. Reconnect with the last cursor and same
owner/targets to suppress unchanged observations; terminal states remain in the
summary. `any-change` detects disconnected changes too. Cursors deduplicate
snapshots; they are neither durable event logs nor authority to drive work.

MCP `forge_wait` has the same inputs; a progress token enables live notifications. A plain budget timeout is a result (`status:"timeout"`), not an MCP error; failures and invalid input set `isError`.
Timeout/cancellation/disconnect closes observation without cancelling work. Native
waits take no Work/Lane locks, start no drivers/checks, make no remote calls and
write no metadata. Filesystem signals plus a two-second fallback cover missed
signals/local runner death. Durable receipts can precede Work metadata; remote
controller loss remains pending for its recovery owner. Hosted waits use the
existing selected-target live queries.

Indexed native landing queues read and publish the selected queue records rather
than hydrating unrelated Lane and run history. A failed sole Candidate in a
non-speculative batch records its diagnosis and terminal entry atomically; it
needs no prefix search or acceptance attempt. Multi-entry batches keep their
parallel/halving diagnosis. Each settled batch updates its requesting land
journal before the channel sweep continues with unrelated submissions.

The native landing worker reconciles active check runs before replaying retained
landing journals. A dead local runner ends as interrupted; a dead Actions
controller is adopted with the original run and provider pins. Release keeps
in-flight check controllers alive on their pinned runtime. SIGTERM and SIGHUP
mean service shutdown rather than remote check cancellation; explicit check or
landing cancellation remains available. If adoption itself
fails, the original run gets an interrupted `CHECK_RECOVERY_FAILED` receipt rather
than retaining a live controller PID with no execution.

CLI and MCP check requests launch a detached controller holding the original
run's exclusive execution lease. The controller keeps its event loop alive until
the durable result, independently of the submitting process or MCP connection.
A queued local handoff whose submitter exits before claim repairs the same wake;
an already started local command is never repeated. Opening an MCP connection does
not register a landing worker or drive unrelated queued landings. The owner service
or the existing detached owner process drives those; commands wake an existing
worker instead of spawning another when one is live.

A newer saved Lane head supersedes an outstanding agent landing goal. The
terminal observation names the newer head and retains the original source, runs
and any earlier acceptance evidence. Other selected Lanes continue. A person
reviewing an exact hosted Candidate retains that reviewed selection.
Unstarted entries whose changed Lane inputs can no longer be resolved end
individually as interrupted with `LANE_STALE` (submission cause `stale-head`) and
“Resubmit at current head.”
Stale composition inputs in retained finish/land journals settle that request too;
other requests continue. Started checks keep their immutable pins and existing
recovery protocol. Worker errors in pending status include the affected operation
and Lane IDs, plus a run ID when known. An error observation remains retryable on
the next durable change or explicit lifecycle wake.

The landing note and the commit message name what the change removes or merges, or why nothing can go
([growth guard](../../lint-rules.md#growth-guard)).
