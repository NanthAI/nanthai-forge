# Journey 35: undo, for a person

Issue a0cf8c22 lists "undo (revert a landing, restore a snapshot)" in the core loop. [Journey 10](10-mistakes-recovery.md) maps every recovery route, mostly from the agent's commands. This file follows the person on the web: something landed that should not have, or an agent's work went wrong, and they want it back as it was.

Walked: the ledger, Lane row, landing decision, signals (Undo), fix-notice and Lane saves sources, the workflows doc (browser review, revert), journey 10's reads and the open Issue e7812d8f. **Not walked:** a revert, an undo of an automatic action and a snapshot restore.

## Steps today

| # | The person wants to | Where | What happens | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Undo a landing made automatically today | Now → "Accepted today" and the ledger: each automatic landing has an `auto` tag and **Undo**. | **Undo** opens a tooltip with "the recorded way back, on tap or hover": text that says how to undo. It performs nothing. On a Lane row the word "Undo" is plain text with the same text as a hover title. | source |
| 1a | Undo a landing in the rebuilt app (`/-`) | A landed Lane's review page, its landing check and its proof page: **Take it out of main** (key `u` on Lane review). | One press starts the revert in step 2, with no confirmation, as the approved design shows; the page says "Taking it out of main as a new landing. It is checked like any other; later landings stay."; Lane review links the reverse Lane's landing check. The "What Forge held" screen (Item 2a5fa2e5) is not rebuilt yet, so the Now and ledger tooltip of step 1 remain there. | source, tests |
| 2 | Revert any landing | The Candidate page of the landed change → **Revert…** → an inline confirmation with an optional Why. "Creates a new Candidate: the reverse of this change on current main", "Checked (verify) and landed through the queue, like any Candidate". Progress: "Preparing reverse Candidate", "Reverse source submitted". Afterwards the original shows it was reverted, by whom, with which check and why. | "Later disjoint landings remain; conflicts surface in the reverse Candidate. Main is never rewound." | source, docs |
| 3 | Undo a revert | Revert the revert, the same way. Not stated on the page. | | source |
| 4 | Respond when Forge reverted a landing itself | Needs you → "Reverted from main": **Start a fix** ("Opens a sibling Lane from the reverted head with the failing tests, the diff and the undo command in its brief. Finishing it lands the original change plus the fix through the full check."), **Undo**, **Close** ("Close without a fix? The Intent is marked abandoned; its Lane and saved head stay."). | | source |
| 5 | Stop a landing in flight | **Cancel landing** on the Candidate page: "Landing cancelled · main unchanged". | | source |
| 6 | Go back to an earlier save of a Lane | Lane page → "Saves and exact snapshots" lists the saves. No control returns the Lane to one. Open Issue e7812d8f (Lane-level undo). | | source |
| 7 | Restore unsaved files an agent lost | CLI only: `x snapshots` (journey 10). The landed page lists "Snapshots kept" as a fact, with no link. | | source |
| 8 | Undo a settings change | Autonomy "edits the existing policy with a pinned prior policy"; no undo control was found. A new change is the way back. | | docs |
| 9 | Restore a deleted project | "Project deleted. You can restore it here for 90 days." **Restore project** (journey 10). | | source |
| 10 | Undo an update from main (a sync) | The queue model carries an undo for a sync, shown as text (the stored value is serialised: "Already undone" or the raw undo data). The agent action `x undo-sync` was "removed with native mode". | | source, ran |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J35-1 | S1 | **"Undo" beside an automatic landing does not undo.** It is a tooltip with instructions, and on Lane rows a word with a hover title. PRODUCT.md makes "Undo next to every automatic action" a source of trust. A person who clicks Undo after a bad automatic landing gets a sentence to read while main stays broken. The real action, **Revert…**, is two pages away on the Candidate. | source |
| J35-2 | S2 | **Two words for the same act, in two places.** Undo (Now, ledger, Needs you) and Revert (Candidate page, CLI). A third, "reverse Candidate", names the result. A person looking for "undo that landing" on the Candidate page finds Revert; a person looking for "revert" on Now finds Undo. | source |
| J35-3 | S2 | **Revert is safe and slow, and the page does not say how slow.** It lands a reverse change through the full check and the queue. That is the right design ("Main is never rewound"). While main is broken the person wants to know: minutes until it is fixed, and whether other landings are held meanwhile. | source, docs |
| J35-4 | S2 | **A revert that conflicts hands the person a merge.** "Conflicts surface in the reverse Candidate." If later landings touched the same lines, the person is sent to "Open the Lane to resolve conflicts", which needs an agent or a terminal ([journey 3](03-conflict.md)). | docs, source |
| J35-5 | S2 | **A person cannot restore anything inside a Lane.** Not an earlier save (not built), not lost unsaved files (CLI only). "Snapshots kept" on the page promises something with no control behind it. | source |
| J35-6 | S2 | **A sync's undo can show raw data.** The model serialises the stored undo value into the text a person sees, and the command it would name was removed. | source, ran |
| J35-7 | S3 | **Undo slots that cannot act say so.** The shared control prints "Nothing to undo." rather than disappearing. That is a good rule; it is applied where an action exists and not where the tooltip stands in for one. | source |
| J35-8 | S3 | **Settings have no undo.** A wrong policy change affects every landing until someone notices; the prior policy is pinned for the write and not offered back. | docs |

## Dead ends

- One click to take back an automatic landing from Now.
- Returning a Lane to yesterday's save.
- Restoring an agent's lost files from the web.

## Naming and tone

- Undo, revert, reverse, roll back (docs: "explicitly select an earlier accepted Candidate to roll back"), restore, cancel, withdraw, close, abandon (journey 10, J10-1).
- "Landing cancelled · main unchanged" is the model sentence: what happened, and what did not change.

## What each persona needs

- **Agent, not person:** covered in journey 10: one family of undo commands outside the operator namespace.
- **Person, not agent:** Undo that acts wherever it is shown; one word; how long the fix will take and what is paused; a way back inside a Lane without a terminal.

## Questions for the owner

1. Does **Undo** on an automatic landing start the revert directly (with one confirmation), and is the word Undo or Revert everywhere? (Owner question 48 on Item 581bd373, open. The rebuilt app uses the approved design's **Take it out of main**, one press, no confirmation.)
2. While a revert of a broken main is in the queue, are other landings held or do they continue?
3. May a revert of a red main skip the queue (land first), since it restores a state that already passed?

Questions 2 and 3 are owner question 49 on Item 581bd373, open; a revert waits in the ordinary queue meanwhile.
4. Is Lane-level undo (e7812d8f) available to a person on the web, as "return to this save"?
5. Do settings changes get an Undo for a period after they are made?
