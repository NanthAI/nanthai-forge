# Item page: text, Done-when lines, work and comments

Design for Item c79cd08f. Mock: [item-page.html](item-page.html). Open it in a browser: the desktop page sits at the top, the edit steps under it and a 390 px phone frame at the bottom; the button at the top right switches between light and dark. It links the real system sheets (`web/src/ds/` and `discussion.css`); page-only classes start with `ip-`. All data in it is sample data.

## Layout

A fixed frame (DESIGN.md rule 3: one Item drives the page), two columns from 861 px:

| Wide column | Narrow column (320 to 400 px) |
|---|---|
| **Text**, **Done when**, **Comments** | **Item** facts, **Work** (Lanes, Landings, Related, History) |

The page head keeps today's crumb, keys (Versions, Split into several…, ⋯) and sentence, and the sentence gains the count: "*Title* is in progress: 2 of 6 Done-when lines ticked, 1 moved." At 860 px and below the page is one column in this order: Text, Done when, Item facts, Work, Comments. Done-when lines come before the facts because they are what the reader acts on. The phone page has no sideways scroll at 390 px.

## What each part reads

| Part | Reads | Change from today |
|---|---|---|
| Text, Done when | the Item record in full, through the same selected work-record read the Initiative page uses for About (`readSelectedWorkRecord`, `batch.ts`); read again only when the live row's `version` changes | **one new bounded read per view** (the body, typically a few KB). Today's page does not read the body. The Item's scale line allows only History as extra, so the lead accepts this read or amends that line. |
| Item facts | the live plan row, as now | none |
| Lanes, Landings, Related | the first `ItemWork` page, as now | none; the top 3 of each show, and **Show N more** reveals the rest of the rows already read; "Show more work" (the next page) stays at the end |
| History | one page of 25 events, read when the page is viewed (it opens by default now) | the one extra read the Item allows; **Show 22 more** reveals the rest of that page, and "Show older changes" reads the next page |
| Comments | the first page is **20** comments (today it is 100); **Show 20 earlier** reads the next 20 | fewer bytes on open than today |

There is no polling and no new subscription; reactive reads stay as they are. Folds keep their remembered state, but a fold with no stored state now starts open for Lanes, Landings, Related and History.

## Text

- The body without its Done-when lines (the task lines and the "Done when:" heading right above them), drawn with the comments' `SafeMarkdown` chunk at the reading measure. Decisions that comments added to the body show here as part of the text.
- Past about 12 lines the text is cut, with **Show all text · N more lines** as a fold in place (rule 46: detail one press away). Long text never pushes Done when off the first screen.
- Header hint: "version 6 · edited 2 h ago by @alex". Empty body: "Nothing written yet." with **Edit text** for writers.

## Done when

Every task line of the body, in body order, one row each:

| State | Box | Word | Under the line |
|---|---|---|---|
| Ticked `[x]` | filled tick box, passed colour | tick glyph, **Done** | "Ticked by landing 8c1e2f40 · yesterday · *who* · evidence" when the landing is known; otherwise "Ticked 2 days ago by *who* · landing not reported · evidence" |
| Open `[ ]` | empty box | none for writers, who see **Tick…** and ⋯; read-only viewers see a ring glyph and **Open** | none |
| Moved `[~]` | dashed box with an arrow | dash glyph, **Moved** | "to *Item link*" when the line names an Item; "not counted" |

The states differ in the box's shape and in the word, not only in colour. Moved lines are not counted, which matches `doneWhenCounts` today: the header count is "2/6", and its hint says "1 moved".

**Which landing ticked a line.** `tick-planning-item` posts its evidence as a decision comment, but the comment does not record which line it ticked, so the page cannot tie a comment to a line reliably. Decision for the lead:

- **Recommended:** the existing tick write stores the line's position on its evidence comment (one optional field on the write that already exists; no new write path and no new read). The page then matches loaded tick comments to lines, and names the landing when the evidence names a receipt.
- **Without that field,** the line says "Ticked · landing not reported" and links **evidence** to Comments with the Decisions filter on.

## Edit flow (owner and planning writers only)

All edits go through the existing commands with `expectedVersion`. Nothing adds a write path.

1. **Edit text:** the Text region turns into a Markdown text box in place (mock step A), holding the body without its Done-when block. **Save text** (⌘↵) writes `put-planning-item` with the Done-when block put back where it was. If the body's task lines are not in one block, the box holds the whole body instead and says so.
2. **Edit a line:** **Edit wording** in the line's ⋯ menu, or a click on an open line's text, turns the line into an input (Enter saves, Escape cancels). The page writes the body with that one line changed.
3. **Add a line:** the last row is "Add a line: what shows it is done" with **Add**. It appends `- [ ] text` after the last task line, or adds a "Done when:" block at the end if there is none. After an add the input stays open for the next line.
4. **Tick…:** opens an evidence field under the line (step C). **Tick and post** runs `tick-planning-item` with that evidence, so the tick and its comment are one step and the evidence is never skipped.
5. **The ⋯ menu:** Edit wording, Mark moved… (asks for the follow-up Item, optional), Reopen (a ticked line back to `[ ]`), Remove line (red, last). Remove and Reopen act at once with a 10-second **Undo** toast (rule 18).
6. **A stale save** (ITEM_CHANGED):
   - A one-line change (edit, add, move, reopen, remove) reads the Item again once and reapplies, but only if that line is unchanged, the same way tick already retries.
   - Otherwise, and always for **Edit text**, a waiting notice reads "@alex saved version 7 while you edited. Nothing was overwritten; your draft is below." with **Compare and redo** (opens Versions on the two) and **Discard my draft**. The draft stays in the box (step B).

Readers who cannot write see no keys, no boxes to press and no add row.

## Comments

- The comment list, composer and reactions stay as they are. The first page is 20; the pager reads "20 of 312 comments loaded" with **Show 20 earlier**.
- A filter bar (rule 7) sits above the list. Each filter is a chip: dashed with "any" when not in use, solid with × when set:
  - **Decisions:** comments marked as decisions;
  - **Review findings:** comments `readReview` recognises;
  - **Author:** one handle, picked from the authors already loaded.
  The count on the right says "4 of 20 loaded".
- Filters run in the browser over the comments already loaded. While earlier pages are unread, one line says so: "Filters look at the 20 comments loaded so far." with **Load 20 earlier**. Filtered to none: "No decisions in the 20 loaded comments", with Clear and Load earlier. There is no server filter, index or query; a server-side filter would be a later Item only if needed.

## Capture

The capture form gains an optional **Description** text box between Title and Done when. Its text goes into the body above the Done-when lines. The form is otherwise unchanged (no mock needed).

## For the builder

- Reuse the system's pieces: `Region`, `Band`, `Row`, `Key`, `Count`, `State`, `Who`, `.chip`, `.tbar`, `.pager`, `.notice`, `Menu`, and `SafeMarkdown` from the comments chunk. The only new page pieces are the Done-when row (`ip-dw`/`ip-box` in the mock) and the text cut.
- Draw the worst case with browser tests: a 300-line body, 40 Done-when lines, 300+ comments, a one-character line, right-to-left text, and phone width with no sideways scroll.
- Removes or merges: the "Done when" fact row (its count moves into the region header and the page sentence). Nothing else can go: the facts, work parts and comments all stay.
