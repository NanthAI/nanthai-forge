# Journey 3: a conflict while landing

Two changes touch the same lines. This journey covers the notice at save time, the conflict at landing, the early-resolve replies (automatic, on and off) and the clean merge that needs nothing.

Walked: `help conflict`, `help overlap`, `help queue`, `policy`, `capabilities`, the early-resolution source (`src/early-resolution.ts`, `convex/projectHostedLandingSpeculativeConflict.ts`), the landing-summary source, the Now overlap and review sources. **Not walked:** a real conflict (it needs two Lanes changing a project).

## Steps today

| # | Moment | Agent sees | Person sees |
| --- | --- | --- | --- |
| 1 | Save, a peer saved the same lines | `conflictNotice` on save, status and land, on both Lanes: file, lines and the other Lane's goal. "Nothing needs an answer: sync or coordinate, save again, and the notice clears once the merge is clean." (ran: help) | Now → "Where work overlaps": "edited by both · lines 40–61 and 48–70", "Whichever is accepted second will need to update from main." An (i) says "Overlaps are advisory: Forge never locks files." (source) |
| 2 | Clean merge at landing | Nothing to do. The receipt records `mainMoved` and `firstCheck.landedOn`; in fast mode the change lands on its own check, in strict mode a moved main may need a second check. (ran: `landings`) | Lane row: "Updated from main · N files". |
| 3 | Conflict with main at landing | `FAILED COMPOSITION_CONFLICT`, a `workIn` line naming the folder to work in, and `Continue recovery: COMMAND`. Exit 2. (source) | Needs you or the Lane: "Can't update from main"; the review page: "Unresolved composition. Open the Lane to resolve conflicts." |
| 4 | Resolving | The folder holds main's lines under `<<<<<<< main`, the Lane's after `=======`, closed by `>>>>>>> lane`, with the common ancestor under `||||||| base`. "A sync is the other way round." Edit every listed file free of markers, then `land --save` from that folder; it saves the resolution and lands it. (ran: help) | **Hand to an agent**; the sheet lists "The conflicting file, both versions". A person cannot resolve in the browser. |
| 5 | Where the resolution lives | In place, when the command ran from the Lane's own folder at the saved head the conflict used. Otherwise a sibling folder. The `workIn` line says which and why. (docs) | n/a |
| 6 | Queued, and main took a file the entry changes | `SYNC REQUIRED; not landed: …` and `Continue recovery: COMMAND`. Exit 2. (source) | Lane: "Main or the Lane moved after submission · not landed". |
| 7 | Exact conflict with a change still ahead in the queue (early resolve) | See the reply below. | Nothing specific. |
| 8 | The change ahead then fails, is withdrawn, enters review or changes | Forge retires the dependent check and restores the Lane to the State its author last saved. A board note names the prior resolution State and the recovery: open the restored Lane, sync main, resolve again. The resolution stays in a retained State. (docs) | Nothing specific. |

### The early-resolve reply

The advice field `wouldConflict.next` (built on the server, `predecessorConflictAdvice`) names the files and the Lane ahead, gives one recommended action with its complete command, and says what a resolution made now depends on (Item 577927f1, J3-1, J3-2, J3-4):

- **Early resolution on**: "Recommended: Resolve now against this exact predecessor, so both land without waiting for it. Run: `nforge agent . sync '{"predecessor":{…}}'`."
- **Off**: "the recommended action is to keep waiting: if it lands, this landing stops with COMPOSITION_CONFLICT and land --save syncs main in and lands again. Or choose sync to resolve now: `COMMAND`."

Both end with the provisional rule: a resolution is built on that Lane exactly as saved (State, receipt) and lands only after it lands; if it fails or is replaced, this Lane goes back to its own last save, the combined save stays in history, and the agent resolves again. The web Lane page shows the same recommendation and command, and marks a combined result Provisional with the save it is pinned to. Reason enums are no longer printed (J3-3). The owner kept this rule on 2026-11-19 (question E20, option A): resolve now unless early resolution is switched off, wait when it is off, and the reply says which it chose and why. The generated agent rule now reads "follow the reply's Recommended command", so the rule and the reply no longer disagree (J3-2).

The setting is `acceptance.earlyResolve`: `"automatic"` (also when absent), `"on"` or `"off"`, changed with `nforge x ROOT set-policy '{"acceptance":{"earlyResolve":"off"}}'`.

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J3-1 | S1 | **The early-resolve reply does not say the resolution is provisional.** If the change ahead fails or changes, the agent's resolution is taken off the Lane's head and the Lane returns to its earlier State. The advice sentence says "Resolve now" and nothing about that outcome. The agent learns it later from a board note, which arrives with its next command. Error-recovery pattern: say where the work is, before it moves. | source, docs |
| J3-2 | S2 | **When early resolve is not chosen, the reply gives two actions and no recommendation.** "choose sync … to resolve now, or wait". The project's own generated rule for agents says the opposite of a choice: "If a queued landing reports wouldConflict, sync and land the same Lane again." | source, ran |
| J3-3 | S2 | **The reason is printed as an internal label.** `cold-start`, `measured-break-even`, `owner-on` and `owner-off` are enum names. An agent can pass them on, but they tell a person nothing ("the owner switched it on", "not enough history yet, so resolving early"). | source |
| J3-4 | S2 | **One sentence carries four ids, two statistics, a mode and a command.** The command inside it is a bare `sync {"predecessor":…}`: not the `save --sync` spelling of the action list and not a full command line, unlike other recoveries. (The CLI adds its own `Continue recovery` line; that path was not walked.) | source |
| J3-5 | S2 | **The marker order flips between two conflict paths.** At landing, main is first and the Lane second; after a sync it is "the other way round". The labels are right in both cases, so the risk is an agent that learned the order, not the labels. | ran |
| J3-6 | S2 | **Eight names for conflict states.** `conflictNotice` (advice at save), `wouldConflict` (advice in the queue), `SYNC_REQUIRED`, `COMPOSITION_CONFLICT`, `RESOLUTION_REQUIRED`, `CONFLICT_MARKERS`, `CONFLICT_SIDE_REQUIRED` and `WORK_CONFLICT`. The web adds "overlap", "Conflict", "Can't update from main" and "Unresolved composition". "Composition" is not in the product vocabulary. | ran, source |
| J3-7 | S2 | **The folder to work in can change.** A resolution is in place or in a sibling folder depending on where the command ran and whether the Lane was saved since. The `workIn` line handles it, but it is the one line an agent must not skip, and it sits among failure lines. | docs, source |
| J3-8 | S2 | **A person cannot see or set early resolve on the web**, nor the failure rate and wait figures the reply quotes. See [journey 6](06-settings.md). | source |
| J3-9 | S3 | **"predecessor"** is the reply's word for "the change ahead of yours in the queue". It appears nowhere in the help topics an agent is sent to (`help conflict`, `help queue`). | ran, source |
| J3-10 | S3 | **A person has no small-conflict path.** Every conflict, however small, goes through an agent or a local checkout. | source |

## Dead ends

- None in the replies read: each conflict state names one continuation. The provisional resolution (J3-1) is not a dead end but a silent reset.

## Naming and tone

- Web: "overlap" (advisory) and "Conflict" (status pill). CLI: "conflict notice", "would conflict", "composition conflict". Docs: "exact predecessor conflict", "early resolution", "speculative". Three registers for one idea: your change and another change touch the same lines.
- PRODUCT.md bans "sync" in product UI ("update from main"). Every conflict recovery in the CLI is a `sync`. The web does say "Updated from main".

## What each persona needs

- **Agent, not person:** the exact pins and one command; the folder; a plain statement of what happens to its work if the change ahead fails.
- **Person, not agent:** who is blocked on whom, and whether anything needs them. Today a conflict reaches a person only when an agent cannot resolve it, and then as "Can't update from main".

## Questions for the owner

1. Answered 2026-11-19 (E20, option A): yes; see [the early-resolve reply](#the-early-resolve-reply).
2. Should every early-resolve reply state that the resolution is redone if the change ahead does not land?
3. Should a person be able to resolve a small text conflict in the browser, or is "hand to an agent" the only route by design?
4. Is "early resolve" the name people will see in settings? The reply needs a plain phrase for "the change ahead of yours".
