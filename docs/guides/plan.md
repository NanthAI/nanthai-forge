# Plan with Items and Initiatives

An Item says what should change and how to tell when it is done. An Initiative groups related Items.

## Find the work

Open Plan for the project's backlog. Read the Item and its comments before starting; the order is the person's order. Done, in progress and left describe Items, while Lanes describe work already under way. Keep those counts separate.

```sh
nforge agent ROOT planning '{"status":"active","limit":50}'
nforge agent ROOT planning '{"id":"ITEM_ID","reconcile":false}'
nforge agent ROOT lanes '{"planningItemId":"ITEM_ID"}'
```

An active Plan read includes proposals and work in progress. Continue a returned cursor when reading more pages. Search for an existing match before adding duplicate work. The [generated reference](../reference/cli.md) gives the current fields for `put-planning-item` and `comment-planning-item`.

An empty Plan read shows how to propose an Item. A fresh Forge-native host prepares Plan when its initial Work projection fits one transaction. Retained Work and larger projections can use the paged rebuild. If Forge returns `PROJECT_WORK_INDEX_MISSING`, follow the owner's recovery command in `next`. From the clone, run `nforge hosted-work ROOT '{"action":"rebuild-index"}'` and retry the read or write. The rebuild resumes from the project's index state.

## Start from the outcome

```sh
nforge agent ROOT start '{"planningItemId":"ITEM_ID","operationId":"UUID","model":"unknown"}'
```

Supply the model ID in `model` or set `FORGE_AGENT_MODEL` in the launcher. Use `"unknown"` if you don't know the ID. The returned Lane stays linked to its Item. Save the work, run affected checks and land. Record evidence for each Done-when line. Keep unmet lines explicit: a landing is not proof of a walkthrough, live cost capture or owner decision that did not happen.

See [the complete planning workflow](../agents/workflow.md) for filtering, versions, comments, grouped work and lifecycle commands. The [capability status](../status.md) distinguishes delivered behavior from work in the phase plan.
