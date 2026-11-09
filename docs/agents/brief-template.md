# Forge builder brief template

Use this portable template for one finite slice. The [standard builder block](briefings.md#standard-builder-block) (start, tests, landing, verification, final report, run metrics) and [AGENTS.md](../../AGENTS.md) apply in full; the current owner instructions win. Do not point a brief at a private rules file; machine values (heavy slots, disk reserve) go in the Disk floor line.

## Task

- Issue: `<full UUID>`; read every **Done when** line with `reconcile:false`.
- Outcome: `<observable result>`.
- Ownership: `<files and concepts owned by this builder>`.
- Dependencies and order: `<Issue/Lane pins; shared concepts and their owners>`.
- Non-goals: `<explicit scope boundary>`.
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
- Independent review: `<required review and scope, if applicable>`.

## Standard safety and delivery block

1. Read Lane AGENTS.md, DESIGN.md, linked rules, the Issue and all its comments. Start from the Issue with your own fresh `operationId` (shared identity on one machine); edit only the Lane's returned root. Never commit in a Git mirror or edit another builder's Lane.
2. Keep private source, prompts, evidence and credentials private. Use synthetic fixtures. Never print secrets or environment values, read credentials raw, or run `npx convex env list`, `env`, `printenv`, `pgrep -fl` or `ps -E`. Compare secrets by hash through approved private delivery.
3. No production, deployment, publication, account changes, outside-user trials or backfills without explicit authorization. Do not add restrictions, limits, pricing, extra steps, access conditions, retention or deletion policy without owner approval. Clear maintenance mode after any approved maintenance.
4. Use the approved installed CLI and patched Node. Check the brief's disk reserve before start/build/tests; use `nforge heavy`. Do not auto-trigger index repair. Bytes go to R2; no per-item Convex calls, polling or idle work.
5. Save at milestones and about every 30 minutes. Retain exact operation IDs and replay requests; use private `mktemp` logs. Answer blocking overlap notices before landing; advisory notices need no answer. Graph coverage never proves independence.
6. Fix the class for every project, add the required guard for repeat classes, and run affected checks. Before filing an Issue or friction, search planning and comment on an existing match. Use `planning {"search":"relevant words","limit":50}` and follow `nextCursor`; add `status:"all"` to include closed work. Never weaken tests or hide failures. Report observed results and unrun checks.
7. Finish and land your own Lane unless this brief explicitly requires review before acceptance. Freeze edits/saves/sync after submission until terminal; keep the turn active with dependent work and resume killed waits with the receipt's original-id `waitCommand` (repeat on IN PROGRESS; see [Waiting for outcomes](workflow.md#waiting-for-outcomes)). Fix failed checks in the same Lane.
8. Match your receipt to your Lane/operation and verify files on accepted main. Comment evidence per Done-when line, retaining unmet lines. Handoff: files, choices, tests/counts/results, receipt/head, current operation, remaining work and next action. Final report fields and the Run metrics block: [standard block](briefings.md#standard-builder-block) item 14. Preserve work before abandoning unused Lanes; remove only your own regenerable temporary output.
