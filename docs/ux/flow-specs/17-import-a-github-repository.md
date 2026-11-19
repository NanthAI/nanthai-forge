# Flow Spec 17: Bring a GitHub repository to Forge

**Goal:** A developer wants their existing GitHub repository on Forge with its history, without breaking anyone who still pushes to GitHub while they move.
**Covers:** R17, R21

---

## Entry Points

- **From Home:** New project, then Import from GitHub.
- **From a setup decision:** the first project's setup offers the import.
- **From their agent:** the agent ran the import command and returned its link.

---

## The Flow

### Step 1: Choose the repository

**What they want:** To pick the right repository.

**What they see:** Their GitHub repositories after they connect GitHub, with search, and a field for any repository address.

**What they do:** Choose one.

**What happens:** Forge reads its size and branches and shows what will come across.

### Step 2: Check what comes across

**What they want:** To know what moves and what does not.

**What they see:** A checklist: the default branch with its full history, tags, file count and size against the limits; what does not come across (pull requests, GitHub settings) and where to read about it. Visibility, matching GitHub by default, with "private here" offered for a public repository.

**What they do:** Choose visibility.

**What happens:** Nothing is imported yet.

### Step 3: Choose how the mirror works

**What they want:** GitHub to stay current while people still use it.

**What they see:** The mirror, on by default, and one question: "Will anyone keep pushing to GitHub?" (draft copy), preselected Yes. Yes keeps it two-way; No keeps it one-way, Forge to GitHub.

**What they do:** Answer the question.

**What happens:** The choice is shown in Settings › Mirror and can be changed there.

### Step 4: Import

**What they want:** The project ready to work on.

**What they see:** Import, then progress by stage (reading, storing history, indexing), never a percentage.

**What they do:** Wait, or leave the page.

**What happens:** The import continues without them; when done, the project opens on Needs me with the next setup step (connect checks), and an email says it is ready.

### Step 5: Confirm it survived

**What they want:** Proof that history is intact.

**What they see:** Code with History listing the imported commits as one block and Who changed these lines working on old lines; the clone command for Git.

**What they do:** Open a file's history.

**What happens:** Old changes show with their GitHub authors.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| Over a size limit | The checklist names the limit and the file or count over it before any import starts. |
| GitHub is not connected yet | The page asks to connect GitHub first and says what Forge will read. |
| The import failed partway | The project says where it stopped, that nothing was lost, and offers Resume. |
| An empty repository | The import completes with no history and the project shows its first-time state. |
| GitHub is down | The page says GitHub is not answering and the import waits; see Flow Spec 24. |
| Someone pushes to GitHub during the import | The two-way mirror brings the push in after the import. |
| A slow import of a large history | Progress stays by stage with the time so far; they may leave and get an email. |

---

## UX Notes

- Leaving must look as easy as arriving: the checklist links to Export (Flow Spec 23).
- *(Pending Decision — journey 12 question 2: open pull requests at the time of the move.)*

---

## Prototype Scope

- The repository picker.
- The what-comes-across checklist with visibility.
- The mirror question.
- Import progress by stage.
- The imported project's History.
- The over-limit and failed-partway states.
