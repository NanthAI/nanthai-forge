# Keep the work moving

Start with what needs your answer, then read what is progressing.

## Find the next decision

Needs me brings held work together. Open the linked Lane or Item, read the cause and answer there. A request asked ahead holds nothing yet; it should not be confused with a stalled landing. The project line shows editing, saved, in queue, checking and main.

```sh
nforge agent ROOT queue '{}'
nforge agent ROOT lanes '{}'
nforge agent ROOT board '{}'
```

Use bounded pages and the returned cursor. Read details for the work in question rather than loading every source file. [Planning](plan.md) keeps the outcome and order separate from the moving Lanes.

## Coordinate an overlap

```sh
nforge agent ROOT peers '{"laneId":"LANE_ID"}'
```

A saved conflict notice is evidence of a real trial-merge conflict; it does not require an acknowledgement step. Coordinate or resolve it, then save. No notice proves nothing about unsaved peer work. [Parallel-work defaults](../parallel-work-defaults.md) explains the project's configurable behavior.

## A landing stops moving

Keep its original operation id. Run the receipt's wait and recovery commands. Check the recorded queue and logs before resubmitting. Stall alerts are event driven and use the project's configured recipients; they do not poll an idle project. [Operations](../operations.md) and [speed budgets](../agents/speed-budgets.md) explain alerts and measurements.

## Read the evidence

Time to main, accepted and discarded checks, failures and unknown coverage are different facts. Use [metrics](../reference/cli.md) and [cost to serve](../operations/cost-to-serve.md). A missing measurement is not zero, and one repository's benchmark is not a promise for another.
