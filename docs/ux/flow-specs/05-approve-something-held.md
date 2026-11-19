# Flow Spec 05: Approve something Forge holds for me

**Goal:** A project owner (or someone the project lets decide) wants to say yes or no to a request that waits on them: a landing held by policy, a fork run, a settings change an agent asked for, or an access request.
**Covers:** R7, R20, R27

---

## Entry Points

- **From Needs me:** the request is a decision in Needs you.
- **From an email:** the batched email links to the request's approval page.
- **From an agent's message:** the agent pastes the approval link it was given.

---

## The Flow

### Step 1: Open the request

**What they want:** To know exactly what they are being asked to allow.

**What they see:** The approval page: who asks (person, or agent session and app, and the person it acts for), what it asks for in one sentence, why Forge holds it (the rule that applies, such as a protected path or a supervised landing), and the exact scope: the paths and changes of a landing, the fork and the check it would run, the setting's current and requested value, or the role asked for.

**What they do:** Read the scope.

**What happens:** Nothing changes.

### Step 2: Look closer when needed

**What they want:** To check the detail before deciding.

**What they see:** Links to the Candidate (for a landing), the fork's changes (for a fork run), and the consequence of the setting (minutes, waiting time, whether main can break).

**What they do:** Open the detail and come back.

**What happens:** The approval page keeps its place.

### Step 3: Decide

**What they want:** To answer and move on.

**What they see:** Approve and Decline, with an optional one-line reason.

**What they do:** Press Approve or Decline.

**What happens:** Forge records the decision with who decided and when, acts on it, and tells the asker on its Lane thread. The request leaves Needs you. The confirmation offers Undo while the action has not run yet.

### Step 4: See the result

**What they want:** To confirm it took effect.

**What they see:** The request marked Approved or Declined, with what happened next (landing in the queue, check started, setting changed with its Undo, access given).

**What they do:** Nothing.

**What happens:** FYI records the decision for others in the project.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| Someone else decided first | The page shows who decided and what; the keys are gone. |
| The request was withdrawn | The page says it was withdrawn and when; nothing to decide. |
| The held landing changed after the request (new save) | The page says the request is for an older save and offers the new one. |
| The reader may not decide | The page shows the request read only and who can decide. |
| Approval failed to record (offline or error) | The keys stay, a notice says nothing changed, and they can try again. |
| Many requests of one kind (a bulk delete of 40 projects) | The whole list, a way to keep any out, and the count typed to confirm. |
| Loading | The page reserves space for the scope; keys wait until the scope has loaded. |
| No requests waiting | Needs you has no approval rows; the approval page of an old request shows its final state. |
| Nothing waiting (empty) | Needs you holds no approval rows; FYI keeps the last decisions made. |

---

## UX Notes

- Approve is a person's word; the landing's result is Accepted only in its receipt.
- The decision is made in the browser. *(Pending Decision — Item 581bd373 question 19: deciding from the terminal with a second factor.)*
- Forge never recommends an answer on spend.

---

## Prototype Scope

- An approval page for a protected-path landing.
- An approval page for a fork run.
- An approval page for a settings change with current and requested value.
- The decided state, for each answer.
- The bulk request with keep-out and typed count.
- The "someone else decided" state.
