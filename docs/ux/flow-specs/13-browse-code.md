# Flow Spec 13: Find and understand code

**Goal:** A person wants to read the project's code as it is on main or at an earlier landing, find who changed a line and why, and compare two versions, without checking it out.
**Covers:** R14

---

## Entry Points

- **From Code:** the place opens on Files at main.
- **From a landing:** "Browse at this landing" in History.
- **From the command palette:** a file name, or a receipt id an agent quoted.

---

## The Flow

### Step 1: Find the file

**What they want:** To get to the file they have in mind.

**What they see:** Files: the tree at main, with marks on files and folders that an open Lane touches, and a search field.

**What they do:** Open folders or search by name.

**What happens:** The file opens; the address names the version and path.

### Step 2: Read it

**What they want:** To read the code with context.

**What they see:** The file at the chosen version, with its size, language and line numbers. Beside it: Changing now (open Lanes that touch it), Landings that touched it, and Who changed these lines.

**What they do:** Select lines.

**What happens:** Who changed these lines shows, for the selection, the landing, the person or agent, and the Item behind each line.

### Step 3: Follow a change

**What they want:** To see why a line is the way it is.

**What they see:** The landing behind a line: title, Item, who, when, its check.

**What they do:** Open the landing.

**What happens:** The landing's change opens in History, with the file in view.

### Step 4: Compare two versions

**What they want:** To see what changed between two points.

**What they see:** Compare, with two version pickers (a landing, or main).

**What they do:** Choose the two versions.

**What happens:** The changed files and their diffs show, in the same diff view as review.

### Step 5: Search the code

**What they want:** To find where something is used.

**What they see:** Search over the indexed files at main, grouped by file, with matching lines.

**What they do:** Type a word and open a result.

**What happens:** The file opens at the matching line.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| An empty project (no files yet) | Files says nothing has landed yet and how the first files arrive. |
| A large file | It opens in pages; the rest loads as they scroll. |
| A binary file | Its size and type, and a download of the exact bytes. |
| The search index is behind main | Results say which landing they cover. |
| No search results | The search says nothing matched and offers file-name search. |
| A version they may not read | The file says it is not available to them, the same for missing and private. |
| Loading the tree | The tree reserves its rows and fills in by page. |
| A file failed to load | The file says it could not be read and offers to try again; the tree stays usable. |

---

## UX Notes

- History is a list of landings, Forge's unit; the Git commit is a detail inside Exact record.
- Public projects reuse these screens read-only for signed-out visitors (owner decision D.9).

---

## Prototype Scope

- Files at main with Lane marks.
- A file with Who changed these lines for a selection.
- Landings that touched a file.
- Compare between two landings.
- Search results.
- The empty-project and large-file states.
