# Convex Workflow for landing phases: spike

Status: **desk spike, read from package source; no prototype was deployed.** It answers whether `@convex-dev/workflow` (built on `@convex-dev/workpool`) should run a short landing phase, such as finish/submit, in place of the hand-rolled bounded steps and scheduler continuations. Labels: **M** = measured or read from source, **E** = estimated, **U** = unrun.

## Recommendation

**Do not adopt.** Keep bounded steps with chained continuations: each step records its cursor, then schedules the next step with one `ctx.scheduler` call. Workflow fails two of the four adopt criteria by construction. It passes the idle test only after a cooldown. The latency limit is unmeasured. Revisit only if a future release removes the per-step orchestration hops and lets in-flight runs survive step changes.

| Adopt criterion | Workflow 0.4.10 / Workpool 0.4.15 | Verdict |
| --- | --- | --- |
| Convex calls and DB bytes not up | **M:** a step is an enqueue, then Workpool loop work (a `getBatch` query plus a `run` mutation per iteration), the step function, a completion record, another loop iteration, a scheduled `complete` mutation, and the workflow's `onComplete`, which replays the handler mutation. That is about 6–8 function executions per step, against 1 for a scheduled continuation. **M:** each replay reads the journal back (every earlier step's arguments and result, capped at 8 MiB), so DB read bytes grow with every step. | Fails |
| Under ~100 ms added per step | **E:** 3–4 scheduler hops (`runAfter(0)`) per step; each hop is a separate transaction. Probably 50–200 ms. **U:** not measured. | Unproven, likely borderline |
| Idle 0 | **M:** with no queued work, the batch-worker loop polls every 200 ms for a 2 s cooldown after its last item, so roughly 10 extra invocations per drain. It then goes idle and cancels its monitor. A truly empty pool makes no calls. Steps seconds apart (compose takes about 4 s) drain the pool between steps, so each step pays the cooldown again. **U:** a 10-minute idle log watch. | Passes after the cooldown; costs calls in between |
| A deploy mid-run does not break in-flight runs | **M:** adding, removing or reordering steps fails active workflows with a determinism violation (README *Limitations*), and step arguments are re-validated on replay. Every `convex/` landing deploys the shared development deployment, which is also the live backend, so active landings would cross deploys. | Fails unless every change ships under a new workflow name |

## Why no prototype

The spike scope allowed a prototype only if it was cheap and behind no production path. Installing a component adds `convex/convex.config.ts` and component tables, which must be deployed to the one development deployment. That deployment serves live hosted traffic, and builders do not deploy. A `convex-test` prototype would count functions but not real scheduler latency or billing, and the two failing criteria above follow from the design, not from tuning. So no prototype was built, and no calls were spent.

Earlier evaluation: [hosted source worker](../operations/hosted-source-worker.md) records the same result for Workflow 0.4.4 / Workpool 0.4.7 (at least five orchestration invocations per lone item, plus a cooldown loop). The 2026-10-28 platform-fit review reached the same verdict for long cursors: journal size, deterministic replay, and step changes breaking live runs.

## Bounded step plus continuation, per landing phase

For the `land --save` hang (Issue 4f60d57a), the client deadline is now a backstop, not the only guard:

- **Wait (where the hung clients sat):** the client is a subscriber; it holds no server work. The server side is already bounded: a pending finish has a 120 s compose watchdog inside a 30-minute watch window, the desired-landing watchdog backs off up to one hour, and `hostedLandingStall` raises a typed stall after 15 minutes without progress. The client wait is capped at 540 s and returns IN PROGRESS with the exact `wait` command. No new continuation is needed. The wait now writes local start and end receipts that name the last observed phase (below).
- **Submit (desired admission):** one short mutation, about 0.13 s in the incident logs. It schedules the driver and never waits for source work. No split is needed.
- **Compose and source steps:** already bounded steps, each of which records a cursor and schedules the next. A transient read error must re-enter the same step rather than end it (Issue eb0491bb), so this stays the hand-rolled pattern.

## Land wait receipts

`land` writes two local `kind:"wait"` receipts to the Lane's existing `.forge-metrics.jsonl`, one before its acceptance (or run) wait and one after it. The end receipt holds the status, duration, event and retry counts, time since the last visible change, and the last compact state (phase, state, reason, version, queue). These are file appends only: no network call, timer or reader. A killed client still leaves the start receipt, so retained evidence names the phase it was waiting in.
