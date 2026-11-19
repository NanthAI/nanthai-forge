# Flow Spec 09: Add an Item to the backlog

**Goal:** A person wants to capture a piece of work in seconds, before they forget it, in the right place in the plan.
**Covers:** R1, R3

---

## Entry Points

- **From Plan:** the capture field at the top of the list, or a group's own capture field.
- **From anywhere in a project:** the command palette's New Item.
- **From an agent:** the agent proposes an Item from the CLI or MCP (see Flow Spec 31 for the agent side).

---

## The Flow

### Step 1: Start capturing

**What they want:** To write the idea down now.

**What they see:** A capture field with focus, and the group it will go into (the Initiative the field belongs to, or No Initiative).

**What they do:** Type a title.

**What happens:** Nothing is saved yet.

### Step 2: Add what matters, if anything

**What they want:** To add detail only when they have it.

**What they see:** Optional fields folded under the title: Initiative, a first Done-when line, type, and where in the order it goes (at the end, or next).

**What they do:** Press Enter, or open a field first.

**What happens:** The Item is created as Planned, in the chosen group and position. It appears in place with its new id and a confirmation that offers Undo.

### Step 3: Keep capturing

**What they want:** To add several in a row.

**What they see:** The capture field empty and focused again.

**What they do:** Type the next title.

**What happens:** Each Item is added below the last one, in the same group.

### Step 4: Review agents' proposals

**What they want:** To accept or reject what agents proposed.

**What they see:** Items agents created as Proposed, marked "added by SESSION", in the Proposed view of Plan (not in Needs me).

**What they do:** Accept (moves to Planned) or mark Won't do.

**What happens:** The status changes with Undo; the agent sees it on its next read.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| Empty title | Enter does nothing; the field says a title is needed. |
| A likely duplicate exists | A quiet line under the field names the existing Item with a link; creating still works. |
| Creating failed (offline or error) | The typed title stays in the field with a notice and a way to try again. |
| An empty plan (first time) | Plan shows only the capture field and one line on what an Item is. |
| The agent's person said to plan it | The agent's Item starts Planned and is marked "added by SESSION". |
| Creating is in progress | The new row holds its place, marked as saving, until it has an id. |

---

## UX Notes

- Capture first, detail later: one field, Enter to save.
- A person's Item starts Planned; ungrouped Items are allowed.

---

## Prototype Scope

- Plan with the capture field focused and three Items just added.
- The folded detail fields opened.
- The duplicate hint.
- The create-failed state with the title kept.
- The Proposed view with agents' Items and their keys.
- The first-time empty plan.
