# Flow Spec 31: An agent picks the next Item

**Goal:** A coding agent told "take the next piece of work" wants the right Item, its whole context and a Lane, in as few calls as possible.
**Covers:** R26, R3, R1

---

For current CLI steps, see [Choose work in Plan](../../guides/plan.md#find-the-work). The next-Item command below describes the target flow.

## Entry Points

- **From its person or a lead:** "pick the next Item in this project".
- **From a hand-over prompt:** the prompt names the Item (Flow Spec 02); the agent skips to Step 3.

---

## The Flow

### Step 1: Ask for the next Item

**What they want:** One Item, not a list to choose from.

**What they see:** The next-Item read: the first Planned Item in plan order that is marked next or comes first, has no open Lane and is not blocked, with its id, title and why it was chosen.

**What they do:** Accept it, or ask for the one after.

**What happens:** Nothing is claimed yet.

### Step 2: Read its context

**What they want:** Everything it needs in one read.

**What they see:** The Item: body, Done-when lines, every comment with its author, blockers by title, its Initiative, and earlier Lanes on it.

**What they do:** Read it.

**What happens:** Nothing changes.

### Step 3: Start

**What they want:** A Lane of its own.

**What they see:** `start` with the Item id and a fresh operation id, returning the Lane path and the project's rules for this Lane.

**What they do:** Start, and work only in that path.

**What happens:** The Item moves to In progress with this session as holder; people see it picked up (Flow Spec 02, Step 4).

### Step 4: Propose work it found

**What they want:** To record a new piece of work without doing it now.

**What they see:** The planning write for a new Item.

**What they do:** Search for a duplicate once, then propose the Item.

**What happens:** The Item is Proposed and marked as added by this session, unless its person said to plan it.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| No Item is ready | The read says nothing is ready and why (all blocked, all held, plan empty). |
| Another agent started it between read and start | `start` returns the other Lane's holder and offers the next Item. |
| The Item has an earlier open Lane | `start` names it; the agent continues or abandons it, never redoes landed work. |
| The read failed | A structured error with `next` and `learn`. |
| An empty plan | The read says the plan is empty and how to propose an Item. |
| A slow read | The read is one bounded page; there is nothing to wait on beyond it. |

---

## UX Notes

- *(Pending Decision — journey 33 question 1: whether "next Item for me" is a read Forge answers or the lead always assigns.)*
- Short ids printed by Forge are accepted where unique *(Pending Decision — journey 33 question 2)*.

---

## Prototype Scope

- None — this flow has no screen; its replies are checked by the agent scorecard run at the Phase 7 close.
