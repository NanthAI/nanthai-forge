# Flow Spec 34: An agent asks or hands back when stuck

**Goal:** A coding agent that cannot continue without someone else's decision wants to ask with fixed answers or hand the work back, so that nothing it did is lost and the right person knows.
**Covers:** R26, R12

---

## Entry Points

- **From its own work:** it needs a decision only someone else can make, or it cannot finish.
- **From a recovery that failed twice** (Flow Spec 33).

---

## The Flow

### Step 1: Decide where to ask

**What they want:** To ask the right person in the right place.

**What they see:** The rule in its guidance: ask the person running it in its own app; use Forge only to ask someone else who must decide (an owner approval, a real choice between options, a hand-off to another Lane's owner), or when it has no terminal.

**What they do:** Ask its own person in its app, or continue to Step 2.

**What happens:** A question in its own app needs nothing from Forge.

### Step 2a: Ask with fixed answers

**What they want:** A decision it can act on.

**What they see:** `ask` with the question and two or three answers, on its Lane.

**What they do:** Ask, then wait.

**What happens:** The question holds the Lane and appears in the decider's Needs you (Flow Spec 07); the reply tells the agent to tell its own user in its app; the wait ends with the answer.

### Step 2b: Hand back

**What they want:** To stop without losing work.

**What they see:** `hand back` with three parts: what it tried, what is left, where the work is.

**What they do:** Save, then hand back.

**What happens:** The Lane keeps every save and has no holder; its person gets a hand-back decision (Flow Spec 07).

### Step 3: Read the answer

**What they want:** To continue with the answer.

**What they see:** On its next command (or after its person pastes the resume prompt), the answer with who gave it.

**What they do:** Continue the task.

**What happens:** The thread records that it saw the answer.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| Nobody answers for a long time | The wait ends at its budget with how long it has waited; the agent may withdraw the question and hand back. |
| The agent stopped before the answer | The answer waits on the Lane; its person gets a resume prompt. Forge never starts it. |
| The question was answered by someone else | The answer shows who gave it. |
| Asking failed | A structured error; retrying with the same operation id does not ask twice. |
| An empty hand-back part | The part reads "not reported" to the person. |
| A slow answer | The wait blocks up to its budget without polling, then returns how long it has waited. |

---

## UX Notes

- Forge is not a chat channel (Item 12fde646).
- `ask` and `hand back` sit beside start, save and land (owner decision I38).

---

## Prototype Scope

- None — the agent side has no screen; the person's side is covered by Flow Spec 07, and the replies by the agent scorecard.
