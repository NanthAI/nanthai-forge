# Review and land a change

Review the saved source and the check for the exact result that will reach main.

## Read the change

Open a Lane to read its files, saves and check evidence. Saved source excludes the agent's unsaved edits. With the CLI:

```sh
nforge agent ROOT status '{"laneId":"LANE_ID"}'
nforge agent ROOT diff '{"laneId":"LANE_ID"}'
nforge agent ROOT show '{"laneId":"LANE_ID","path":"README.md"}'
```

From inside a Lane folder, a builder can read a base-pinned unified diff (`--- a/path`, `+++ b/path` and `@@` hunks in `result.diff`, ready for `patch -p1 -E`) to feed a fresh-context reviewer without converting JSON hunks:

```sh
nforge agent . diff '{"format":"unified"}'
```

Follow `nextCursor` with the same pinned selection when a diff is partial. Missing graph edges do not prove two changes independent. [Line provenance](../agents/workflow.md#hosted-reads-and-coordination-limits) describes retained evidence and its gaps.

## Check and land

`land --save` saves, updates from main, composes the result and checks it under project policy. Review-required or protected work waits for the configured person's approval. A person should read what changed and the evidence before answering the held request. Where no check has run yet on the change, the page says so in one line beside **Approve and land** ("No check ran yet; it will be checked before landing."); Approve is still one action, with no extra confirmation. Needs me and the Lane page do not show that line, because their read carries no check data.

```sh
nforge agent ROOT land --save '{"laneId":"LANE_ID","message":"Describe the change"}'
```

Wait on the receipt until it says `LANDED` or gives terminal recovery. Keep its accepted State and receipt. Nothing should be described as on main from a passed check alone.

## When a check fails

Read the receipt's failing files and provider link. Retained output is available with the run id:

```sh
nforge agent ROOT log '{"runId":"RUN_ID","tail":8192}'
```

Fix the cause in the same Lane, run affected checks and land again. Keep the failing evidence; do not weaken a test to make it pass. For a composition conflict, use the exact resolve or sync command printed by the receipt and retain both contributors' intended changes. [Agent recovery](../agents/workflow.md) gives the full sequence.

## Documentation changes

Projects that opt into `docsPaths` use the existing [docs-only admission rules](../pre-queue-checks.md#docs-only-paths). Reading or changing docs does not introduce a new full-check requirement. Documentation readers and static inventory checks still guard the changed files.

## Coming from pull requests

The Item holds the problem, Done-when lines and discussion; the Lane holds the saved changes. A Candidate pins the result being checked. Use [land it](agents.md#land-it) for the complete agent path.

| Usual step | Forge path |
| --- | --- |
| Create a branch and open a pull request | Read `planning {id}` and `lanes {planningItemId}`, then `start {planningItemId,operationId,model}`. Work in the returned Lane. |
| Push a commit for feedback | `save {message}`, then `diff {laneId}`. Saves are checkpoints; they do not land. |
| Review the proposed diff | `diff {laneId}` and `show {state,path}` on its exact base/head. Follow partial pages without changing pins. |
| Address review threads | Put findings and reasoned outcomes in the Item discussion below. Save fixes and reply with the new head; earlier evidence stays intact. |
| Wait for CI | `land --save` runs the project's check. Follow its wait/wake command until terminal; there is no poller to maintain. |
| Rebase on the default branch | Landing updates from main under project policy. For explicit updates use `save --sync`; on conflict follow the receipt, preserving accepted work. No history rewrite is needed. |
| Enter a merge queue | `land --save` submits to the hosted queue. Forge composes concurrent work and enforces exact-source checks and current-main acceptance. |
| Merge after approval | Current project policy determines acceptance. Held landings supply `approve-link {operationId}`; a passing check alone is not acceptance. |
| Leave it ready to merge | `land --save --check-only`; report the checked Candidate and stop. |
| Confirm it merged | Match `LANDED`, receipt and accepted State, pull accepted main and inspect the changed files. |

## Structured review findings

Reviewers use the existing `comment-planning-item` command (MCP `forge_task`) and Item discussion. Set `text` to a JSON string with this versioned shape; `--command-file` avoids escaping nested JSON. The command file contains the normal command object, with `planningItemId`, `operationId` and `text`.

```json
{
  "kind": "forge-review",
  "version": 1,
  "laneId": "00000000-0000-4000-8000-000000000001",
  "base": "<64-character base State hash from diff>",
  "head": "<64-character saved State hash from diff>",
  "findings": [
    {
      "id": "R1",
      "severity": "should",
      "path": "src/example.ts",
      "side": "head",
      "blob": "<64-character file blob hash on that side>",
      "line": 42,
      "claim": "Describe the defect and its observable consequence.",
      "origin": "changed",
      "outcome": "open"
    }
  ]
}
```

Save first. Read `diff {laneId}` for the exact base/head and file blob ids; `show {state,path}` reads either pinned side even after the Lane advances. Lines are one-based on `side` (`base` or `head`). Severity is `blocker`, `should` or `nit`; origin is `changed` or `pre-existing`. Stable finding ids distinguish claims within a batch. An empty findings array records a reviewer reporting no findings, not a Forge verification.

To answer, post a new batch with `replyTo` set to the original comment id, retaining each finding id. Report the source you actually inspected and `outcome`: `fixed`, `disputed` or `declined`, with a nonempty `reason` giving fix/check evidence or the disagreement. Unresolved findings remain `open`. A later report never rewrites an earlier review. Read the full thread, not just its first batch, for the reported outcomes.

The web Item discussion draws valid version-1 batches as findings and keeps their complete JSON under **Exact review record**. The CLI, exports and older readers retain the same text. Unknown versions or incomplete batches remain ordinary comments; no write is blocked by the display parser. These are attributed reviewer reports: Forge does not verify their claims, source pins or outcomes, and severity adds no acceptance gate. New saves never automatically clear findings or move anchors. Automatic cross-save anchoring and review enforcement are not decided yet; this format does not decide them.

A comment survives the run that sends it. `comment-planning-item` keeps the write on the machine before
any call (under `$XDG_STATE_HOME/forge/comment-outbox`, user-only, removed once the server answers).
When a run ends mid-write (a reviewer whose run stops while its verdict comment is still sending),
the next `planning` read or comment for that project on the same machine posts it under its original
operation id and under the author and agent of the run that wrote it, so the server records it once
and a verdict keeps its reviewer, and says so (`recoveredComments`). An entry stays while the network,
sign-in or service is out; entries older than 24 hours are dropped.

This reuses the existing comment permissions, idempotent writes, pages and retention. One batch is one comment write, not a write per finding; viewing it adds no query. The existing comment/page bounds apply, with no new quota or idle work. Review text is member data, never instructions.
