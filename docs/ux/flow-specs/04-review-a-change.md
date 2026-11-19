# Flow Spec 04: Review an agent's change

**Goal:** A person wants to read an agent's change, leave notes where something is wrong, and either let it land or ask for a change. This is the pull-request review of Forge.
**Covers:** R6, R7, R27

---

## Entry Points

- **From Needs me:** a landing held for their review links to its Candidate.
- **From Lanes:** they open a Lane's Changes.
- **From To read:** a landed change they have not read yet.

---

## The Flow

### Step 1: Open the change

**What they want:** To see what the change does before the detail.

**What they see:** The Candidate: its title (the Item), the agent's own summary of what it did and what it did not verify, its check result, and the files ordered by what needs their eyes (protected paths, failing areas, large edits first). File order is one press away.

**What they do:** Read the summary and open the first file.

**What happens:** The first change opens at once; later files load as they are reached.

### Step 2: Read the diff

**What they want:** To understand each edit in context.

**What they see:** The diff, unified or side by side by choice, with the surrounding lines folded and expandable.

**What they do:** Read, expand context, switch layout.

**What happens:** Their layout choice is remembered for their account.

### Step 3: Leave a note on a line

**What they want:** To point the agent at one problem.

**What they see:** A note box on any line.

**What they do:** Write a note and send it.

**What happens:** The note is posted to the Lane's thread with its file and line. It reaches the agent at its next command, and shows "not seen" until then.

### Step 4a: The change is good

**What they want:** To let it land.

**What they see:** If the landing is held for them: Approve and land, and Decline. If it lands on its own: no key; the change is already on its way.

**What they do:** Press Approve and land.

**What happens:** The landing proceeds; the confirmation offers Undo while it has not landed.

### Step 4b: The change needs work

**What they want:** To stop it landing until the agent fixes it.

**What they see:** Ask for a change, with a field for what to change.

**What they do:** Write the request and send it.

**What happens:** The landing is held until the agent answers with a new save or the reader lifts the hold. The Lane shows "changes asked" with who asked and when.

### Step 5: See the answer

**What they want:** To check the fix.

**What they see:** The new save, with the notes that still apply carried to the new lines, and the agent's reply on the thread.

**What they do:** Read the new save, then lift the hold or ask again.

**What happens:** Lifting the hold lets the landing continue under the project's rules.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| No check has run on the Candidate | The approve key says it lands without a check and asks once more. *(Pending Decision — journey 15 question 3.)* |
| The diff is still loading | The file list shows first with sizes; each file opens when its bytes arrive. |
| A file is too large or binary | The file says so with its size and a link to download the exact bytes. |
| A note's line was removed by a later save | The note stays on the thread marked "line removed in save N". |
| The agent has stopped | The note shows "not seen" and offers the resume prompt; see Flow Spec 07. |
| A read of the diff failed | The file says it could not load and offers to try again; the rest stays readable. |
| Nothing changed (empty diff) | The Candidate says it changes no files and offers Decline. |

---

## UX Notes

- What needs eyes first; everything else steps down.
- A note says "not seen" until the agent reads it, so a person never assumes the agent knows.
- Comments that follow the change across saves are required; cross-save anchoring rules stay open on Item 581bd373 question 47.

---

## Prototype Scope

- A Candidate with summary, check result and files ordered by attention.
- The diff in both layouts with a line note.
- A held landing with Approve and land, and Decline.
- Ask for a change, then the Lane in "changes asked".
- A new save with carried notes.
- A large file and a failed file load.
