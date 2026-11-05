# P6 planning: build plan (4 slices + 1 optional)

Status: unshipped design input; see [README](README.md) for caveats and the synthetic-data note.

Each slice: one builder, one Lane, targeted tests, its own hosted landing, handoff doc. Budgets are for a 100-item project with 10 Initiatives; report measured calls and DB I/O in the handoff. Idle is always 0 Convex calls. Any capable agent can build a slice; the lead checks each against the mockups.

## Slice 1: model, derived status, capture, list (the backbone)
Build: `type`, `parentId`, `order`, `notBefore`, `fields`, `closedBy`, `decision` on comments; `planningStatus` projection written from Lane/check/queue/landing hooks; `planningDaily` buckets; Initiative one-liner and project situation from counts; quiet-Initiative rule; `plan add/list/show/status/comment/close/reopen/abandon` (CLI + `forge_plan`, `forge_plan_write`); web List view per SPEC §1–5, §13–14 (no reorder yet; order = server rank, new Items at end); History view §10 without full-text search (title match only); skill text block.
Acceptance: fixture project with 9 Items in 3 Initiatives: Lane start → Working; check running → Checking; check passed + queued → Ready; conflict → Conflict; landing → Done with sha; two Items sharing one Lane both show Working; sub-item roll-up "2 of 5"; one-liner matches the template for each Initiative; quick capture Enter/⌘Enter/undo/offline retry with same operationId; List renders a seeded demo project with group counts equal to CLI `plan status`; Alive excludes closed Items older than 24 h; 390px no overflow.
Budget: List = 1 items query (≤ 100 rows, ≤ 60 KB) + 1 initiatives-with-status query (≤ 20 rows) + 1 project situation row; History = 1 paged query of 50. Writes: ≤ 1 extra `planningStatus` write per Lane/check/queue/landing event, ≤ 1 `planningDaily` write per Initiative per event. Target DB I/O per List open ≤ 150 KB; idle 0.

## Slice 2: Item page, Initiative page, Board
Build: Item page per SPEC §9 (Work chain, Fields with inline change, Sub-items add/list, Conversation with decision toggle, Refine actions Split/Merge/Move/Close/Abandon/Hand to an agent, History); Initiative page per §8 without charts (swimlanes yes); Board per §7; `plan edit/move (Initiative/parent only)/merge/split`.
Acceptance: split creates ordered sub-items and the parent shows "0 of n"; merge closes the source with `closedBy.merge`, moves comments as quotes and links Intents; Move between Initiatives updates both one-liners in the same revision; Work chain shows Intent → Lanes → newest check rail → landing from the fixture; Board columns equal the derived statuses of the List; swimlane fill rules match SPEC §8 for every status in 07-states.html; keyboard map §12.
Budget: Item page = 1 item detail + 1 status row + 1 comments page + lazy history page (on open); Initiative page = 1 items page scoped by Initiative + 1 status aggregate; Board = the same items query as List (shared cache) grouped client-side. Idle 0.

## Slice 3: reorder and policy, auto-tracking setting, settings page
Build: fractional rank mutations with `before/after`; drag + keyboard reorder per SPEC §6; `planning.reorder` policy (`people` default, `people+own`, `all`) with agent refusal codes; Settings › Planning per §11 (Track work in planning: Link work to Items on by default; Agents write Item text off; Types; Fields ≤ 6; Quiet days); auto-link: `start` without an Item creates one titled from the outcome under `initiative` (title prefix) or none, landing closes it with evidence; `start` and the skill text read the policy flags; group-by any field incl. custom fields.
Acceptance: two people reorder concurrently, both see the same final order with no rank collisions after 1,000 random moves (property test); agent move refused under `people`, allowed for own Item under `people+own`; auto-link on: Lane start without Item → Item appears Working in the right Initiative within the same revision, lands → Done with sha; auto-link off: nothing created; group by `area` shows empty bucket last; setting changes carry Undo.
Budget: a move = 1 mutation, 1 row write (rank), 0 reads of siblings beyond the two neighbours; auto-link = 1 extra write on start and 1 on landing; Settings page = 1 read. Idle 0.

## Slice 4: charts and full-text history search
Build: burn-up and flow SVGs per SPEC §8 from `planningDaily` (30 days), quiet line under two days, computed one-line observation; History full-text search over titles, bodies, comments and reasons with highlight, "Everything" scope; Export stays.
Acceptance: fixture with 10 days of events renders the charts in 07-states/04-initiative geometry, values match `planningDaily`; a day with no events repeats the previous bucket; a search for a word that occurs only in a close reason finds the Item and highlights the excerpt; 50-per-page continuation.
Budget: charts = 1 query of ≤ 30 rows per Initiative; search = 1 paged search-index query (Convex search index on a `planningText` row per Item that is updated on writes), no scans. Idle 0.

## Slice 5 (optional, after dogfood): v2 niceties
Bulk select + Move/Set type, saved views per account, Proposed-from-outside triage row actions (Plan it / Decline) for public projects, `plan list --format table` for humans in the terminal. Only if friction logs ask for them.

## Order and dependencies
1 → 2 → (3 ∥ 4). Slice 1 is the critical path and replaces the current Planning list; keep the existing export and provenance views intact. Docs Lane after slice 3: `docs/concepts.md` Planning section, `docs/agents/workflow.md`, llms text.

## Cross-cutting acceptance (every slice)
- Idle Convex 0 (open Planning in two tabs for 10 min: zero function calls after load).
- No new CSS beyond `.pl-*` in SPEC; tokens only from `tokens.css`.
- All strings from SPEC §5 fact lines; no "AI", no exclamation marks, no money.
- Targeted tests only locally; the landing check is the full run.
- Measured numbers (calls, bytes, rows) in the handoff, compared with the budget above.
