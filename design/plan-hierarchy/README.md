# Plan hierarchy: children, drag to re-parent, relations, New Initiative, the capped Done-when bar

Design for Item 5907e992. Mock: [plan-hierarchy.html](plan-hierarchy.html). Open it in a browser. Desktop is at the top and a 390 px phone frame is at the bottom; the button at the top right switches between light and dark. It links the real system sheets (`web/src/ds/` and `web/src/app/plan/plan.css`), and page-only classes start with `hz-`. All data is sample data. It builds on the signed-off Item page ([design/item-page](../item-page/README.md), Item c79cd08f) and keeps the documented model: one parent per Item, one level drawn ([planning](../../docs/planning.md#items-and-initiatives)).

## Layout

**List and Tree (mock 1, 2).** A sub-item is numbered from its parent: `3.1`, `3.2` in the rank column, in the second ink so it reads as part of 3. Tree adds the 16 px indent it has today and an elbow in `--text-3` joining the child to the row above. The parent's flags say "2 sub-items". List by hand keeps the number and the place but has no indent. Under any other sort, or when a filter hides the parent, there is no hand number, so the child names its parent in the row: "under 3 · *Cache stops…*" (a link, full title on hover). On a phone the number and the elbow stay, and the row stacks as today. The Board is unchanged.

**Drag (mock 3, 4).** One gesture with three outcomes, set by where the pointer is over a row:

| Where | Shows | Does |
|---|---|---|
| top or bottom quarter of a row | the orange drop line; it starts at the level it lands on (indented means "under the row above"); label "Top level · 2nd", "Under 3 · becomes 3.2", "Moves to Release 2 · 1st" | reorder, un-parent (a child dropped at top level) or move to another group |
| middle half of a row | the row on the selected tint, outlined in brand orange; label "Put under · becomes 2.1" | make that row the parent; the Item goes last among its new siblings |
| a row that cannot take it | no outline; the reason in ink ("One level only: 3.1 is a sub-item") | nothing |

Every drop is one batch and shows a toast with **Undo** (rule 18), for example "Put *X* under *Y* (2.1). Undo". Today's reorder is a put without Undo; it moves to the batch too. Escape cancels. With the keyboard, Enter on the handle picks the row up and the arrows step through every between and onto target, each one announced; Enter drops. On a phone, and from the keyboard menu, the handle's menu adds **Put under…** (opens the parent picker) and, for a child, **Out of 3 · *title*** (it becomes top level, right after its old parent). Dragging works only in hand order with no filter, as today.

**Item page (mock 5, 6).** Only the narrow column changes:

1. **Item facts**: a new **Parent** row. A top-level Item shows "none, top level" and **Set parent…**. A sub-item shows the parent's number and title as a link, with **Change…** and **Clear**. An Item with children of its own shows **Set parent…** disabled, with "has 2 sub-items; one level only" beside it.
2. **Children** (new region): rows in hand order with their number, status and Done-when bar, plus a ⋯ menu (Open, Make top level). Under them are **New child**, which opens a title field in place (Enter adds it and the field stays open for the next), and **Add existing…**, which opens the picker.
3. **Relations** (new region): bands for Depends on, Blocks, Duplicate of and Related, each with × to remove. Blocks is set on the other Item and its band says so; removing one edits that Item. Under the bands, **Add relation** offers the kind as a segmented choice, then the picker. Work's **Related** band moves here.
4. Work, Text, Done when and Comments are as in design/item-page. The Done-when header carries the bar beside its count.

Phone order: Text, Done when, Item facts, Children, Relations, Work, Comments.

**The search picker** is a combobox: the input, with a list on the menu's surface under it (a sheet on a phone). It filters the loaded plan rows as you type, by title words or an id prefix (`matches()`). Each result shows its number, Initiative and status. A result that cannot be chosen stays in the list, greyed, with its reason ("this Item", "one level only: it is 3.1", "already Depends on"). The footer says "3 matches in the loaded plan". Only when the plan read is partial does it add **Search all open Items** (see Read cost).

**New Item (mock 7).** The sheet starts with a segmented choice, **Item | Initiative**. Initiative shows Title and Text and **Create Initiative**; the new Initiative lands last among Initiatives. Item keeps today's form plus the Description from c79cd08f and an optional **Parent** picker. Choosing a parent sets the Initiative to the parent's and locks that field, labelled "from its parent".

## The Done-when bar (mock 8)

**12 blocks at most, 82 px wide (today's shards: 5 px blocks, 2 px gaps).**

- Up to 12 lines, a block is one line, drawn exactly as today.
- Past 12 lines, a block stands for n / 12 lines (2¼ at 27 lines, 5 at 60).
- Blocks fill from the left by count. The row has only `[ticked, total]`, so the bar shows how much is ticked, not which lines.
- A partly ticked block fills from the bottom in **thirds**, in `--passed` over `--rail-off`. With `f = ticked × 12 / total`, the first `⌊f⌋` blocks are full. The next block shows ⅓ or ⅔: the step is `⌊(f − ⌊f⌋) × 3⌋`, raised to ⅓ if it would be zero.
- So a block is full only when every line it stands for is ticked, and one tick in 60 still shows.

Mock examples: 2/3, 5/8, 7/12 (one block per line); 10/27 (4 full, the 5th a third); 44/60 (8 full, the 9th two thirds); 1/60.

Why these numbers:

- **12 blocks.** Every Item with 12 lines or fewer (most of them) looks the same as now. 82 px fits the row's Done-when column beside the owner at 1440 px and the Item page header. 12 divides by 2, 3, 4, 5 and 6, so 24, 36, 48 and 60 lines give whole lines per block.
- **Thirds.** On an 11 px block a third is about 4 px, the smallest step that still reads. Quarters would be under 3 px.
- **Height steps rather than tint steps.** A part-filled block is a shape (rule 14) that reads in greyscale, and it uses only the two colours the shards already have.

The exact count `44/60` always stays beside the bar. The hover title adds "a block is 5 lines". On a phone the row hides the bar as today (`plan-wide`); the Item page and the Children rows show it.

## What each control writes (existing commands only)

The web sends every write as one `projectPlanningBatch:apply` call (`runBatch`): puts carry `expectedVersion`, and **Undo** is `batchUndo`. That is the same path as `put-planning-item {"batch":[…]}`.

| Control | Writes |
|---|---|
| Reorder (drop line, menu Up/Down) | put `{order}`: a rank between its siblings (`movedRank`) |
| Put under (drop onto a row, picker, menu) | put `{parentId, order}`, with `order` last among the new siblings. If the parent is in another Initiative, the same put also sets `initiativeId`, and the batch adds the two "Moved in/out" comments that **Move to…** writes today. A dragged parent that changes Initiative takes its loaded open sub-items with it (one put each, within the 100-write batch) |
| Clear, Out of *parent*, Make top level, dropped at top level | put `{parentId: null, order}`, placed right after the old parent or at the drop line; the stored Initiative is kept |
| New child | put with `expectedVersion: 0`, `kind: "issue"`, title, `status: "open"`, the parent's `initiativeId` and `fields.parentId`. One operation id per draft, as Capture does, so a retry never files the Item twice |
| Add existing child | put on the child: `{parentId}` (plus `initiativeId` and the comments if it changes Initiative) |
| Add or remove a relation | put on this Item with the whole `fields.relations` list. A Blocks row (or the other side of a link) is removed by a put on the other Item |
| Create Initiative | put `{kind: "initiative", title, body, status: "open"}`, `expectedVersion: 0` |

A refused `ITEM_CHANGED` overwrites nothing, and the row goes back to where it was (mock 4: "*X* changed since this page read it (version 4). Nothing moved. Try again"). For a change to one field (a parent, or a single relation added or removed), the page reads the Item again once and reapplies only if that field is still as it was, the same way a tick retries.

## Refusals

The web never builds deeper nesting or a loop. It decides this from the loaded rows, before any write, and shows the reason on the drop target or the picker row:

- **Itself**: an Item cannot be its own parent or relate to itself. The server also refuses this (`BAD_ARGUMENT`).
- **One level, so no cycles**: a parent must be a top-level Item, and an Item with sub-items cannot be put under another. Then no chain can loop. This is the rule the bulk bar's **Put under…** already uses.
- **Initiatives are not parents**: the server refuses this. A drop on an Initiative's band means "move to that Initiative, top level".
- **Cross-Initiative**: never refused. A child goes into its parent's Initiative, and the drop label or picker row says so first ("also moves this Item to Release 2"). This keeps stored membership, and with it the progress counts, matching what the tree shows.
- **Relations**: the same kind cannot be added twice. There can be at most 20 relations ("20 relations, the most an Item holds"). A depends-on that would make both Items block each other is refused.
- **Who can write**: people who can only read see the same rows, facts and lists, with no handles, keys or pickers.

## Read cost

| Part | Calls |
|---|---|
| Numbers, elbows, "under 3", the parent's child count | 0: worked out from the loaded Plan rows |
| A drop, or any write above | 1 batch call; Undo is 1 more. Today a reorder is also 1 call |
| Picker while typing | 0: it filters the loaded rows |
| **Search all open Items** | 1 one-shot `projectHostedPlanningSearch:search` (`status: "active"`, `kind: "issue"`, `limit: 10`), the read ⌘K already uses for ids. It runs only on that press or on Enter, never per keystroke, and is cached per text while the picker is open. It is offered only when the plan read is partial (`more`), because each search is billed at the project's full search-index size whatever the limit. No new index, no subscription, no polling |
| Item page Parent and Children | 0: from the loaded Plan rows. A partial plan shows the children count with `+` |
| Relations | 0: Work's first page already resolves related titles both ways (it moves from the Related band) |

One Item page view reads no more than c79cd08f set.

## For the builder

- `ReorderList` (`web/src/ds/behaviour/ReorderList.tsx`, the only layer that imports the library) gains an optional drop onto a row: the library's `dropPosition: "on"`, plus a callback that returns a refusal reason or nothing. The drop line takes an indent for the level. Nothing else in the system changes.
- Removes or merges:
  - The `total <= 12` branch in `rows.tsx` `DoneWhen` becomes one capped drawing for every length.
  - Work's Related band merges into Relations.
  - The bulk bar's **Put under…** list (30 titles) is replaced by the same picker.
  - Today's reorder put moves into the batch, so it gains Undo instead of adding a path.
- Worst case to draw: a parent with 40 sub-items (numbers `3.40`), titles of one character and in right-to-left script, a 60-line and a 1-line Done when, a picker with 0 matches ("No open Item matches 'x'" and Clear), 20 relations, and 390 px with no sideways scroll.

## Question for the lead

The server refuses only an Item being its own parent. The CLI can still write a parent that is itself a sub-item (drawn flattened) or a loop (drawn under No Initiative). **Recommended:** the put that sets `parentId` also refuses a parent that has a parent. That costs one point read of the parent and nothing at idle, and it closes every loop, so the CLI and the web refuse the same things. It would be a small separate Item. **Alternative:** keep the documented "flattened" rule and leave the guard in the web only.
