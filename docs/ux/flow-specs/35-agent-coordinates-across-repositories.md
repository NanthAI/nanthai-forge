# Flow Spec 35: An agent coordinates a change across repositories

**Goal:** A coding agent (or a lead agent) wants a change that spans two projects to land in the right order, without guessing when the other part landed.
**Covers:** R26, R10

---

This spec describes first-class cross-repository dependencies, which are pending. Today, [order separate landings](../../guides/agents.md#work-across-two-repositories) using their receipts.

## Entry Points

- **From its task:** the Item needs a change in a library project and in the app project that uses it.

---

## The Flow

### Step 1: List the projects it may act in

**What they want:** To know where it can work.

**What they see:** The projects its person can reach, with its access in each.

**What they do:** Pick the two projects.

**What happens:** Nothing changes.

### Step 2: Start a Lane in each

**What they want:** One Lane per project, tied to one Item.

**What they see:** `start` in each project, naming the Item in the first project as the link.

**What they do:** Start both Lanes and work in each path.

**What happens:** Both Lanes show the shared Item; people see both on the Item.

### Step 3: Say what depends on what

**What they want:** The app's Lane to land only after the library's.

**What they see:** A dependency on a landing in another project.

**What they do:** Declare the app Lane depends on the library Lane.

**What happens:** The app Lane's landing waits until the library Lane lands, and says so.

### Step 4: Wait and land

**What they want:** Both on their mains, in order.

**What they see:** One wait over both Lanes.

**What they do:** Land the library Lane, then the app Lane, and wait.

**What happens:** Both land in order; the receipts name each other.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| The library Lane fails | The app Lane keeps waiting and says why; nothing lands out of order. |
| No access to one project | The list shows read only, and `start` there is refused with who can grant access. |
| Only one project exists | The list shows one project; there is nothing to coordinate. |
| The wait reaches its budget | It returns both Lanes' states and the command to keep waiting. |
| Loading the project list | It is one bounded page. |
| A Lane with no saves yet | The dependency can be declared; the dependent landing waits all the same. |

---

## UX Notes

- *(Pending Decision — Item 581bd373 question 87 and journey 33 question 6: a first-class cross-repository link, and whether this journey is scored before it exists.)*

---

## Prototype Scope

- None — the agent side has no screen; until cross-repository links exist the scorecard records this journey as not yet supported.
