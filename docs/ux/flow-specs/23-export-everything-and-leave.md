# Flow Spec 23: Export everything and leave

**Goal:** A project owner wants to take their project elsewhere, or prove before committing that they could, with full history and all their planning and discussion.
**Covers:** R21, R27

---

## Entry Points

- **From Settings:** Project, Export and leave.
- **From the account:** Your data, for everything the person owns.
- **From the import checklist:** "How to leave" before they import.

---

## The Flow

### Step 1: See what is exported

**What they want:** To know exactly what they get.

**What they see:** Export: a Git repository with full history (clone command, or the mirror if it is current), and one archive of everything else: Items, Initiatives, threads, landings and their receipts, settings, in a documented format.

**What they do:** Start the archive.

**What happens:** Forge prepares the archive in the background and says how long it usually takes.

### Step 2: Get it

**What they want:** The files on their machine.

**What they see:** The archive ready, with its size, the date, and a download link that ends after a stated time; an email says when it is ready.

**What they do:** Download it and clone the repository.

**What happens:** The download starts; the export is recorded.

### Step 3: Leave

**What they want:** To close the project on Forge.

**What they see:** Delete this project, which keeps it 90 days in the trash, and what happens to the mirror (it stays on GitHub, untouched).

**What they do:** Type the project name and delete.

**What happens:** The project moves to the trash with a restore link; landings stop; the mirror is left as it is.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| The archive failed | The page says it failed, that nothing changed, and offers to try again. |
| The download link ended | The page offers to prepare a new archive. |
| Lanes are still open | The export includes their saves and says which Lanes were open. |
| Preparing a large archive | The page shows the stage and that they may leave. |
| A project with nothing yet | The archive is still made, with empty files in the same format. |

---

## UX Notes

- Leaving is shown as plainly as arriving; it is read before sign-up as often as at the end.
- *(Pending Decision — Item 581bd373 question 31: the exact promise for leavers and whether the mirror carries imported history.)*

---

## Prototype Scope

- Export with what is included.
- The archive preparing and ready.
- Delete this project with the trash period.
- The failed and link-ended states.
