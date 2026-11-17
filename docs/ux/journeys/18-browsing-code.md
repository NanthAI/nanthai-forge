# Journey 18: browsing code and history

Reading a project without changing it: files, search, history, blame, what landed and the receipt behind each landing. Mostly a person on the web; the agent reads the same things through the CLI.

Walked: `history` (status and a two-entry log), `landings`, `lane-history`, `help review`, the Code, file, history and ledger sources, the workflows doc (Code, search, source links) and the Git serving doc. **Not walked:** a rendered Code page, a blame and a search.

## Steps today

| # | Goal | Person (web) | Agent (CLI) |
| --- | --- | --- | --- |
| 1 | Browse files on main | Code → Files: an expandable tree of "the exact main head", text "read on demand in pages", "Find a file". "Tree dots mark files and folders an open Lane touches, coloured by the most urgent Lane." "No files in main." | `show '{"channel":"main","path":"FILE"}'` returns exact bytes. There is no list-files read in the help; an agent lists files in its checkout. (ran: help) |
| 2 | Read one file | Syntax highlighting; a **This file** column with "Changing now", "Symbols (top-level JavaScript/TypeScript declarations on the loaded page)" and "History (the most recent acceptances touching the file)". "Raw text is unavailable for this file." for some. | `show` with `state`, `candidateId`, `laneId` or `at:"base"`. |
| 3 | Find something | ⌘K: "Search matches current-project Intents, Lanes, Candidates and available indexed files", five per group. Files match by name. | Ordinary search tools in the checkout. Full-text search across the hosted project is not built (open Issue 8dcd61fc, Phase 9). |
| 4 | See what landed | Now → "Accepted today"; the ledger: "What landed on main", "Who accepted", "Full history". Each row opens the Candidate review ([journey 15](15-reviewing-agent-work.md)). | `landings '{"from":"DATE","to":"DATE"}'`: per landing `receiptId`, `submissionId`, `laneId`, `intentId`, times, `landedHead`, `checkRunIds`, `costs`. No title or message in the row. (ran) |
| 5 | Git history (log) | No commit list on the web was found. | `history '{"op":"log","limit":N,"path":"FILE"}'`: commit, parents, author, dates, subject. "log, blame and old versions match GitHub." (ran) |
| 6 | Blame | Not on the web. | `history '{"op":"blame","path":"FILE","start":N,"end":M}'`: "ranges of final lines per commit with author and summary". (docs) |
| 7 | An old version of a file | Copy link "retains its source head"; "Save links open immutable saved source in the Code frame … file links include an exact #L line anchor." | `history '{"op":"show","commit":"…","path":"…"}'`, or `show '{"state":"…","path":"…"}'`. |
| 8 | Compare two points | The Candidate diff ([journey 15](15-reviewing-agent-work.md)). No "compare any two versions" control was found. | `diff` compares a Lane's base to its saved head only. |
| 9 | Read a receipt | "Exact record: Candidate, pins, receipts", folded, on review and Needs you rows. | `lane-history '{"laneId":"…"}'`: `openedAt`, `startBase`, `lastSyncedBase`, `state`, `head`, `landing {receiptId, commit, current, revertedBy}`. (ran) |
| 10 | With plain Git | `git clone` of the project, read-only ([journey 11](11-leaving.md)). | The same. |
| 11 | A submodule | "Code and Now show `submodule → URL @ short sha`; a submodule is a leaf, never an expandable source folder." | Checked out at its pinned commit. |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J18-1 | S1 | **The web has no history of the project.** A person can see what landed today and a ledger of landings, and for one file its recent landings. There is no commit list, no blame, no "this file last year", no compare. The data exists and is exact (the CLI's `history` matches GitHub). People from GitHub open the history tab first. | source, ran |
| J18-2 | S2 | **Two histories with different names and ids.** Landings (receipt id, State head: 64 hex characters) and Git commits (40 hex characters) describe the same main. `history` returns both `commit` and `headState`; `landings` returns `landedHead`, which is neither a Git commit nor shown with one. Nothing tells a reader that one landing equals one commit. | ran |
| J18-3 | S2 | **`history` is missing from the help.** It works and is documented in the agent workflow doc, but `nforge agent ROOT help` lists no `history` line, so an agent that reads the help does not learn it can read the log or blame. | ran |
| J18-4 | S2 | **A two-entry log downloaded 38 MB.** `history '{"op":"log","limit":2}'` reported `downloadedBytes: 38097704` (the stored packs) to return two commits. On a larger repository a first log is slow and costly; nothing in the reply warns of it. | ran |
| J18-5 | S2 | **Search finds names, not code.** ⌘K matches file names and Work titles. Searching for a function or a string needs a local checkout. | docs |
| J18-6 | S2 | **A landing row has no title.** `landings` gives ids, heads and times; the message a person wrote is absent (journey 2, J2-8). The web ledger shows the Item title and who approved. The CLI reader has to join three reads. | ran |
| J18-7 | S2 | **"Receipt" is hidden from people and central for agents.** PRODUCT.md keeps receipts inside "Exact record". Agents get receipt ids in every reply. A person asked by an agent to "check receipt 1aff2aac" has no field to paste it into; ⌘K does not search receipts. | source, ran |
| J18-8 | S2 | **No compare between two versions.** The journeys Issue lists "diff between States". Only a Candidate against its base, or a Lane against its base, can be compared. | source, ran |
| J18-9 | S3 | **Symbols only for JavaScript and TypeScript, only on the loaded page.** Other languages show an empty Symbols section; long files show partial symbols. | docs |
| J18-10 | S3 | **Agents cannot list files on the server.** Reading one file by path works; discovering paths in a project the agent has not checked out does not. `diff` with `summary:true` lists changed paths only. | ran: help |
| J18-11 | S3 | **States, heads, checkpoints, Candidates and commits all appear in links and replies** as names for "a version". A person needs one word. | docs, ran |

## Web history and Code, as specified (Items 3968a655, 90e5bc9c)

The rebuilt Code place under `/-` answers J18-1 for history and leaves blame and compare open. Question 64 on 581bd373 stays open for the owner. The run brief settled its first half: history is a list of landings.

- **History is landings, not commits.** Code → What landed lists main's receipts, newest first, 25 at a time. Each row has the title from the landing message, who landed it (a public handle and agent run), when, and the check. A row opens its receipt: why, who and with which app, how it was checked, time to main where saved evidence covers it, the files it changed, and links to the files as that landing left them and to the Lane. Only receipt fields are read. A missing message is said as "Landing" plus the short State, never invented. A landing with no saved evidence shows no time to main.
- **Files at an exact State.** Code → Files reads main, or any landing's State through `?at=`. Folders arrive one page at a time and the file one page at a time, so a large repository never downloads whole. A deep link opens its folders. `#L` selects a line. Binary files, submodules, missing paths and unavailable sources are said in words. Another source is never substituted.
- **A file's history** checks the newest 8 landings (or 8 from the pinned one) on a press, comparing each landing's two States, and links each match to its receipt. Beyond that, the CLI's `history` log is the answer for now.
- **Visibility.** History and files read from the same project as the file reader. History needs sign-in today. Signed-out public reading arrives with 4c164732 and 6a60e89a without changing the views.
- **Open: blame** (who wrote this line) and **compare any two States**. Both have exact readers on the server (`history` blame, the source reader's two-State compare). Their phase is question 64, and full-text search stays with 8dcd61fc. When they come, they link from the file pane next to "Landings that touched it" and keep the file's visibility.
- **Not shown yet:** Lanes changing this file now, and graph coverage per file. No read gives per-Lane paths cheaply today.

## Dead ends

- "Show me the history of this file" on the web beyond its recent landings.
- "Who wrote this line?" on the web.
- "Find where this function is called" on the web.
- Pasting a receipt id anywhere in the web app.

## Naming and tone

- "Accepted today", "What landed on main", "Who accepted": the owner's decision is that land is the event and accepted a receipt state, so these become "Landed today" and "Who approved" (tracked on a4c5394c).
- "Changing now" on a file is a strong idea that GitHub lacks: the file page shows who is editing it right now.

## What each persona needs

- **Agent, not person:** exact bytes at an exact version (present); blame for a line range before it edits (present, undiscoverable); a cheap log.
- **Person, not agent:** a history tab with landings as the entries (title, who, when, check, revert state), blame, a compare, and full-text search. One id per version that can be pasted into search.

## Questions for the owner

1. Is the web history a list of landings (Forge's unit) with the Git commit as a detail, or a Git log?
2. Do blame and compare on the web belong in Phase 7 with the code view, or with full-text search in Phase 9?
3. What is the one word for "a version of the project" that people see: State, version, or the landing itself?
4. Should a receipt id be searchable from ⌘K, so a person can follow what an agent quotes?
5. Is a server-side file listing for agents wanted, or is "check it out first" the rule?
