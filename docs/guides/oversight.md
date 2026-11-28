# Keep the work moving

Start with what needs your answer, then read what is progressing.

## Find the next decision

Open the project's **Needs me** page. **Needs you** shows decisions addressed to you, such as approving a landing, answering a question or responding to a Lane parked for you. Open the linked Lane or Item to read the evidence and answer. A question asked ahead joins the count once it holds work.

Check **FYI** for news such as a failed check another Lane owner can fix. Open that Lane, then choose **Checks** for its landing check. When a landing is held for approval, the Lane shows why, and the owner can add a reason with **Approve and land**. **Loose ends** lists work that was started and left open. The project line shows editing, saved, in queue, checking and main.

Open a row in **Recent landings** under Flow to see its receipt in Code History. A saved title fits on one line beside its ID, such as `#32224`. Acceptance saves the title for Flow, so **Clear all** in FYI leaves it visible. A landing submitted without a message shows its ID.

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

In **Lanes → History**, open a landing to see the check result and time to main that Forge recorded. **Take it out of main**, when offered for an automatic landing, starts a new checked landing against that receipt. Later landings stay.

Time to main, accepted and discarded checks, failures and unknown coverage are different facts. Use [metrics](../reference/cli.md) and [cost to serve](../operations/cost-to-serve.md). A missing measurement is not zero, and one repository's benchmark is not a promise for another.
