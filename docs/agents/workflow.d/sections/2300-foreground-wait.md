### Foreground wait

Elsewhere `land --save` / `finish` blocks by default. Keep the turn active while your work
is unfinished. A progressing hosted landing's `next`, `command` and `waitCommand`
name one blocking continuation on the original operation:

```sh
nforge agent ROOT wait '{"operationIds":["ORIGINAL_UUID"],"until":"acceptance"}'
```

`wait` blocks for its budget, then returns one line. A landing that ends failed
exits 2 (the same as `land`); landed or superseded exits 0; a plain budget timeout keeps
exit 3. In agent mode the budget is
540 s, under the 10-minute tool limit of common agent shells; `--budget 90s` (CLI)
or `maxWaitMs` (MCP `forge_wait`) sets another. Unfinished work returns
`IN_PROGRESS` (exit 3) with the same resume command: run it again in the
foreground. Never resubmit, sleep between checks or end the turn on a background
wait. MCP sends progress notifications while it waits.
For a single landing, the `wait` and foreground `land --save` budget replies use the
latest pending phase delivered for the observed attempt by the existing subscription.
When that progress updates the foreground display, `pendingProgress` carries its
phase and version alongside the observed submission. The continuation still selects
the original operation, and settlement still comes from its canonical landing record.
`land --save` uses the same 540 s budget for its whole run (submission and wait,
`--budget` sets another) and ends `IN_PROGRESS` (exit 3) with its exact resume command.
If a hosted `save` replies `settling`, follow its wait command or check its outcome
on the next command in that checkout. Waiting uses the save's progress subscription
and advances the local Lane binding from a completed receipt. A wait that reaches
its budget returns `IN_PROGRESS` with the continuation.
A new `save` or `save --sync` first settles (waits for) a save this checkout left unfinished. A sync whose retained
request the server refuses as `WORK_STALE` (no operation began) is rebuilt once from
current pins; an identical later sync after the Lane moved starts a fresh operation.
When the rebuild is refused too because only Lane metadata moved elsewhere (acceptance, a pin or a reopen from
another root: same saved head and sourceVersion), the checkout binding follows the server once (one Lane read, only
on this refused path) and the same operation is rebuilt, so a retained sync needs no `save` or `open` first. A newer
saved head still ends with the one `save` that rebases local edits.
A hosted `start`, `sync` onto main or `land --save` request that pins the main it observed,
and that the server refuses as `CHANNEL_CHANGED` because main moved first (no operation
began), is rebuilt on the current main under the same operation, up to 3 tries per call;
`land --save` composes again when main moved after its compose. A replay of the original
request after a `CHANNEL_CHANGED` therefore builds on the new main; no fresh `operationId`
is needed. An explicit `target` or `candidateId` stays the caller's pin and is not rebuilt.
Native operations use `until:"terminal"`. Hosted check-only and harness checks use
`{"runId":"RUN_ID"}`; native checks use their run operation id. Before admission,
source preparation keeps the full original replay command.
Retryable source work follows its returned recovery; a child failure does not settle a pending landing.
`--no-wait` returns with an unfinished-work warning and the blocking continuation.
A wait whose read fails for a reason other than its own selection (for example
`HOSTED_PROTOCOL_INVALID` while the CLI and server versions differ) changes nothing
on the server: its error carries `recovery.command`, the same wait to run once the
cause is fixed. `BAD_ARGUMENT` and `NOT_FOUND` keep their own message.
`HOSTED_PROTOCOL_INVALID` with the "upgrade nforge" step means the deployment's reply failed the
reply boundary (unknown keys are dropped; missing, mistyped or unknown-enum fields fail) and names
the failing reply fields. The same code without that step names the failing path of a request or
local file; upgrading is not known to help. A wait or `land` that spans a server deploy still
reports the landing's outcome when a reply changed shape under it: the result carries
`contractSkew` (`paths`, `dropped` optional fields, `stable` when only the stable outcome fields
were read, `side`: which side is older, and `message`). Only when even the outcome fields are
unreadable does it fail, saying the landing may have succeeded, which side is older and the
`landings` command that checks it; a run wait names `status {"runId"}`. Neither adds a call. A bare `start {}` (no `planningItemId`, `intentId` or `outcome`) is refused with `BAD_ARGUMENT`
before any call or journal exists (Issue ec7bd1b5).

LANDED reports acceptance; CHECK PASSED alone does not. Follow failure/conflict
recovery in the same Lane; inspect current Lane status after supersession.
Single-target hosted CLI/MCP waits expose `submission` alongside `submissions`.
External drivers without Forge run IDs need their harness's original wait/recovery.
Hosted peer waits require a submitted operation ID; an unsubmitted Lane is not a
hosted wait target.
