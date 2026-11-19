# Flow Spec 08: Undo a landing or a Lane's save

**Goal:** A person wants something back as it was: a landing that should not be on main, or an agent's Lane that went wrong after a good save.
**Covers:** R9, R27

---

## Entry Points

- **From History in Lanes:** an automatic landing shows Take it out of main.
- **From FYI:** a landing row or a "main broke" row offers the same.
- **From a Lane:** the Lane's History lists its saves.

---

## The Flow

### Step 1: Find what to undo

**What they want:** To find the landing or save that went wrong.

**What they see:** For a landing: its title, who landed it, when, its check and what it changed. For a Lane: its saves in order, each with time, a short summary and files.

**What they do:** Choose the landing, or the save to return to.

**What happens:** The choice opens with its detail.

### Step 2a: Take a landing out of main

**What they want:** Main without that change, keeping everything after it.

**What they see:** Take it out of main, and a line saying it lands as a new change that is checked like any other, and that later landings stay (draft copy).

**What they do:** Press Take it out of main.

**What happens:** Forge prepares the exact reverse change and puts it in the queue as an ordinary landing. The landing's row shows "being taken out" with the reverse's place in the queue.

### Step 2b: Return a Lane to an earlier save

**What they want:** The Lane as it was at a good save.

**What they see:** Return to this save beside each earlier save, and what the return drops (the later saves stay in history).

**What they do:** Press Return to this save.

**What happens:** The Lane's head moves to that save; the later saves stay in its history and can be returned to. The holder is told on the thread.

### Step 3: See it done

**What they want:** To know it worked and nothing was lost.

**What they see:** For a landing: the reverse landed, with its receipt and how to bring the change back (land the original again). For a Lane: the Lane at the chosen save, with Undo for the return.

**What they do:** Nothing.

**What happens:** FYI records the undo for others.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| The reverse conflicts with later landings | Forge says it cannot take it out cleanly, names the files, and offers Hand to an agent with a prepared prompt. |
| The reverse touches protected paths | The reverse waits for approval like any held landing; see Flow Spec 05. |
| The reverse's check fails | The row shows the failure; main is unchanged until the reverse lands. |
| The Lane has a landing in flight | Return to this save waits until the landing settles, and says why. |
| A Lane with one save | No earlier save to return to; the option is absent. |
| Loading saves | The Lane's History reserves rows while its saves load. |
| Nothing has landed yet | History is empty, so there is nothing to take out of main. |

---

## UX Notes

- Main never rewinds; undo is always a new landing.
- One press, no confirmation for Take it out of main; the result is itself undoable. *(Pending Decision — Item 581bd373 questions 48 and 49: the final word and whether a revert of a failing main may skip the queue.)*
- *(Pending Decision — journey 35 question 5: an Undo window for settings changes.)*

---

## Prototype Scope

- An automatic landing with Take it out of main, and its "being taken out" state.
- The reverse landed, with how to bring the change back.
- A Lane's saves with Return to this save, and the returned state with Undo.
- The conflict state with Hand to an agent.
