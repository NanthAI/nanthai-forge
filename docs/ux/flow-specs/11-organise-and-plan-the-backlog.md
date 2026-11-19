# Flow Spec 11: Organise and plan the backlog

**Goal:** A person wants the backlog in the order work should happen, grouped so they can see each part of the plan, and a clear "next" for agents to pick up.
**Covers:** R3, R2, R10

---

## Entry Points

- **From Plan:** the place opens on the hand-ordered List, grouped by Initiative.
- **From an Initiative:** its page shows its Items in order and its progress.

---

## The Flow

### Step 1: See the plan

**What they want:** To see the whole plan and where it stands.

**What they see:** Plan as one hand-ordered list grouped by Initiative (No Initiative last). Each group shows its roll-up ("2 of 9 done" (draft copy)) and folds to one line. Each row: title, status, the "next" marker where set, blocked-by titles, Done-when progress, owner or "no one yet". Views: List, Tree, Board; grouping by Initiative, owner, type or none.

**What they do:** Fold groups they are not working on.

**What happens:** Folds are kept for their account.

### Step 2: Put things in order

**What they want:** The most important work first.

**What they see:** Drag handles in List and a drop line naming the new position.

**What they do:** Drag rows up or down, or use the keyboard move.

**What happens:** The new order is recorded with who moved what and Undo. Agents read the same order.

### Step 3: Mark what is next

**What they want:** Agents to pick up the right Item first.

**What they see:** Set as next on each row; the "next" marker stands out from other row marks.

**What they do:** Set one or more Items as next.

**What happens:** The next Items are first in the agents' "next Item" read (see Flow Spec 31).

### Step 4: Group work into an Initiative

**What they want:** A name for a part of the plan and its progress.

**What they see:** New Initiative, and Move to Initiative on rows.

**What they do:** Create an Initiative and move Items into it.

**What happens:** The group appears with its roll-up; its page holds a short written summary beside the generated progress line.

### Step 5: Split or relate work

**What they want:** To break a large Item into parts or say what blocks what.

**What they see:** Add sub-item and Blocked by on an Item.

**What they do:** Add sub-items, or link a blocker.

**What happens:** The parent shows its sub-items' progress; a blocked Item shows the blocker's title and is skipped by the next-Item read until the blocker is done.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| An empty plan | Plan shows the capture field (see Flow Spec 09). |
| Two people reorder at once | Both moves are recorded in order; the list shows the result and the history shows both. |
| An agent reordered | The move shows "moved by SESSION" in history with Undo. |
| A reorder failed | The row returns to its place and a notice says so. |
| A very long plan | Groups fold to their roll-up; rows load by page within a group. |
| A blocker is in another project | *(Pending Decision — Item 581bd373 question 87: cross-repository links.)* |
| Loading | Groups show their titles and counts first; rows fill in. |

---

## UX Notes

- One order for people and agents; every move is recorded and undoable.
- The plan answers "what is done, in progress and left" at a glance from existing data.

---

## Prototype Scope

- Plan List grouped by Initiative with roll-ups and the next marker.
- A drag with the drop line, and history showing an agent's move.
- Board view with group bands across the columns.
- An Initiative page with its summary and progress line.
- An Item with sub-items and a blocker.
