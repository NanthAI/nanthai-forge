# Forge builder brief template

Use this portable template for one finite slice. The [standard builder block](briefings.md#standard-builder-block) (start, tests, landing, verification, final report, run metrics) and [AGENTS.md](../../AGENTS.md) apply in full; the current owner instructions win. Do not point a brief at a private rules file; machine values (heavy slots, disk reserve) go in the Disk floor line.

## Task

- Issue: `<full UUID>`; read every **Done when** line and comment (`planning {"id":"ISSUE_ID"}`).
- Outcome: `<observable result>`.
- Ownership: `<files and concepts owned by this builder>`.
- Dependencies and order: `<Issue/Lane pins; shared concepts and their owners>`.
- Non-goals: `<explicit scope boundary>`.
- Removes or merges: `<what this change deletes or folds into something that exists, or why nothing can go>`; the landing note repeats it ([growth guard](lint-rules.md#growth-guard)).
- Invariant: `<root cause and all instances to search, not just one reproduction>`.

## Budget and acceptance

- Scale: `<current records/bytes and growth>`.
- Cost: `<calls per record/operation, total Convex calls, DB documents read/written, byte placement, peak memory and wall time>`; idle = zero calls; batch by page.
- Docs-only alternative: runtime calls, DB I/O, memory behavior and byte placement do not change. State the planning-read/write and landing budget instead.
- Disk floor: `<GiB free required before start, builds and tests>`.
- Time box: `<time and a concrete handoff checkpoint if incomplete>`.
- Done when: `<behavior, failure cases, evidence per line, required repeats and noise allowance>`. Name the behaviour, contract or incident each line guards, so the builder tests that and nothing else ([test signal](lint-rules.md#test-signal)); do not write "add tests".
- Must not regress: `<metric and comparison method>`.
- Targeted verification: `<affected tests, docs, format/lint/type checks>` (the guarded behaviour decides which tests exist, never a count); full verification belongs to the landing runner.
- Independent review: `<required review and scope, if applicable>`; omit to use the default one round through [the review script](review-api.md) (other model family than the builder; add `review-tier: core` to the Item for a core, queue, security or root-cause Lane), or name the model reviewer here.

## Standard safety and delivery block

When running unattended, edit files only with the file-edit tool inside your Lane.
Keep temporary files, including logs, in `.forge/scratch/` inside your Lane. Create it when needed.
Do not start local dev servers or pipe a read into a write.
Read first, then pass a literal argument to the write command.
If a command waits for approval and nobody can answer, cancel it and use the routes above.

1. Read Lane AGENTS.md, DESIGN.md, linked rules, the Issue and all its comments. Start from the Issue with your own fresh `operationId` (shared identity on one machine); edit only the Lane's returned root. Never commit in a Git mirror or edit another builder's Lane.
2. Keep private source, prompts, evidence and credentials private. Use synthetic fixtures. Never print secrets or environment values, read credentials raw, or run `npx convex env list`, `env`, `printenv`, `pgrep -fl` or `ps -E`. Compare secrets by hash through approved private delivery.
3. No production, deployment, publication, account changes, outside-user trials or backfills without explicit authorization. Do not add restrictions, limits, pricing, extra steps, access conditions, retention or deletion policy without owner approval. Clear maintenance mode after any approved maintenance.
4. Use the approved installed CLI and patched Node. Check the brief's disk reserve before start/build/tests; use `nforge heavy`. Do not auto-trigger index repair. Bytes go to R2; no per-item Convex calls, polling or idle work.
5. Save after each meaningful step and about every 30 minutes (each save runs the exact conflict check). Retain exact operation IDs and replay requests; use private `mktemp` logs. Read any `conflictNotice` a save returns (a real trial-merge conflict with a peer; nothing to answer). Graph coverage never proves independence.
6. Fix the class for every project, add the required guard for repeat classes, and run affected checks. Before filing an Issue or friction, search planning and comment on an existing match. One `planning {"search":"relevant words","limit":10}` is enough (no `nextCursor` paging); add `status:"all"` to include closed work. Never weaken tests or hide failures. Report observed results and unrun checks.
7. Finish and land your own Lane unless this brief explicitly requires review before acceptance. Freeze edits/saves/sync after submission until terminal; keep the turn active with dependent work and resume killed waits with the receipt's original-id `waitCommand` (repeat on IN PROGRESS; see [Waiting for outcomes](workflow.md#waiting-for-outcomes)). Fix failed checks in the same Lane.
8. Match your receipt to your Lane/operation and verify files on accepted main. Comment evidence per Done-when line, retaining unmet lines. Handoff: files, choices, tests/counts/results, receipt/head, current operation, remaining work and next action. Final report fields and the Run metrics block: [standard block](briefings.md#standard-builder-block) item 13. Preserve work before abandoning unused Lanes; remove only your own regenerable temporary output.
9. Finish what you find. Work you or a reviewer find while building is in scope when it serves the Item's goal: review findings, missing tests or edge cases, a bug in code you touched, a cost that grows per landing, a docs gap. Add it to the Item's Done-when list and do it before the Item closes, in this Lane or a successor Lane on the same Item (land what is done first if the Lane is getting too large to review). Open a follow-up Item only when the work needs an owner decision or design not yet given, waits on another open Item, belongs to a different feature or area the goal does not cover, or is a dated re-check. Say which of these applies in the follow-up and in your report.
