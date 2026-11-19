# Flow Spec 10: Edit, move or delete an Item

**Goal:** A person wants to correct an Item, move it to another group or status, or get rid of it, with nothing lost by mistake.
**Covers:** R2, R27

---

## Entry Points

- **From Plan:** a row's menu, or dragging a row in List or Board.
- **From an Item:** its title, body and fields are editable in place.
- **From the command palette:** Move, Close and Delete act on the open Item.

---

## The Flow

### Step 1: Edit in place

**What they want:** To fix the title, body or a Done-when line.

**What they see:** The Item with each field editable where it is.

**What they do:** Change the text and leave the field.

**What happens:** The change is saved with a new version; the Item's history records who changed what.

### Step 2: Move it

**What they want:** To put it in another Initiative, position or status.

**What they see:** In List, a drag handle and a drop line that says where it will land ("Planned, 3rd in plan order" (draft copy)); in Board, columns by status; in the menu, the same moves by name.

**What they do:** Drag it, or choose a move from the menu (keyboard: pick up, choose, drop).

**What happens:** The move is recorded with Undo. A move to In progress is refused: an Item is in progress only when a Lane starts on it.

### Step 3: Close it

**What they want:** To mark it done or not needed.

**What they see:** Close, with the open Done-when lines listed if any.

**What they do:** Close it; with open lines, pick a quick reason ("not needed", "done elsewhere") or move the lines to a follow-up Item.

**What happens:** The Item is Done, or Abandoned with its reason (won't do, duplicate, superseded). It leaves the open views; Undo is offered.

### Step 4: Delete it

**What they want:** To remove an Item made by mistake.

**What they see:** Delete in the menu.

**What they do:** Press Delete.

**What happens:** The Item moves to Deleted and stays there 30 days; the confirmation offers Undo. Deleted lists it with the date it goes for good.

### Step 5: Restore it

**What they want:** To get back an Item deleted by mistake.

**What they see:** Deleted, with each Item's title, who deleted it and when it goes for good.

**What they do:** Press Restore.

**What happens:** The Item returns to where it was, with its history.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| Someone else edited it at the same time | The later save is refused in words, with both versions shown and a way to keep either. |
| The Item has an open Lane | Moving it back to Planned is refused, naming the Lane to set aside first. |
| A move failed (offline or error) | The row goes back to where it was and a notice says so. |
| Deleted is empty | Deleted says nothing was deleted in the last 30 days. |
| A sub-item's parent is deleted | The sub-items move with it and return with it. |
| Loading a long plan | Rows load by page and keep their place; a drop line works only on loaded rows. |

---

## UX Notes

- Undo over confirm: every move, close and delete is one press with Undo.
- Closing with open lines never drags: one quick reason is enough.

---

## Prototype Scope

- An Item edited in place.
- A drag in List with the drop line, and the keyboard move.
- A Board move between Proposed and Planned, and the refused move to In progress.
- Close with open lines and the quick reasons.
- Deleted with Restore, and empty Deleted.
- The edit conflict state.
