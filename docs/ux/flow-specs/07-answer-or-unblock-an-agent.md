# Flow Spec 07: Answer or unblock an agent

**Goal:** A person wants to give an agent what it needs to continue: an answer to its question, a decision on a hand back, or an order between two agents whose Lanes wait for each other.
**Covers:** R12, R13, R11, R27

---

## Entry Points

- **From Needs me:** a question, a hand back or an order decision in Needs you.
- **From an email:** the batched email names the agent and the question.
- **From a Lane's thread:** the question is pinned first on the thread.

---

## The Flow

### Step 1: Read what the agent needs

**What they want:** To understand the question without the whole history.

**What they see:** The decision: the question as its title, the agent's own words quoted, what it holds (the Lane and where it is on the four stops) and for how long, and one key per fixed answer. A recommendation only when Forge has a fact for it.

**What they do:** Read it, or open the thread for context.

**What happens:** Nothing changes.

### Step 2a: A question with fixed answers

**What they want:** To pick an answer.

**What they see:** One key per answer, with an optional one-line reason.

**What they do:** Press an answer.

**What happens:** The answer is posted under the question on the thread; the hold is lifted; the keys give way to the chosen answer.

### Step 2b: A hand back

**What they want:** To decide who carries on.

**What they see:** What the agent tried, what is left and where the work is (saves, last save time, files), with "not reported" for any missing part. Keys: Hand to an agent (copies the resume prompt), Take it yourself, Set it aside, or for a hand back to another person, Take it and Decline.

**What they do:** Press one.

**What happens:** The holder changes and is recorded; a declined hand back returns to the sender's person and both are told.

### Step 2c: Two Lanes wait for each other

**What they want:** To choose which lands first.

**What they see:** The two (or three) Lanes, what each changes on the shared lines, what Forge knows (which has passed a check), and one key per order: Land A first, Land B first.

**What they do:** Press an order.

**What happens:** The order is recorded with who chose it, shown on both Lanes and in FYI, and the confirmation offers Undo. The second Lane updates from main and is checked again after the first lands.

### Step 3: Know whether the agent got it

**What they want:** To be sure the answer reached the agent.

**What they see:** A delivery line under the answer: "Seen by SESSION at TIME", or "Not seen: SESSION has run no command since TIME. The answer waits on the Lane." with Give this to your agent, which copies a resume prompt.

**What they do:** If not seen, copy the resume prompt into the agent's app.

**What happens:** The agent reads the answer on its next command. Forge never starts the agent.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| The agent withdrew the question | The decision leaves Needs you; the thread shows it was withdrawn and when. |
| Someone else answered first | The decision shows who answered and with what; no keys. |
| An overlap an agent is already settling | It stays in FYI; no order decision appears. |
| Sending the answer failed | The keys stay, a notice says nothing was sent, and the answer can be sent again. |
| The question holds no work yet (asked ahead) | It is listed under Asked ahead and not counted. |
| The thread is empty apart from the question | The thread shows only the pinned question and the composer. |
| Loading the thread | The pinned decision shows first; older messages load above it. |

---

## UX Notes

- One message system: one thread per Lane or Item; board notes and session messages are part of it.
- Questions for the person running an agent stay in that agent's own app; Forge holds only questions for someone else or from agents with no terminal (Item 12fde646).
- Owner and write roles may order Lanes; read roles see the decision read only.

---

## Prototype Scope

- A question decision with three answers, in Needs me and pinned on the thread.
- A hand back with the three parts and its keys.
- The order decision for two Lanes, with Undo after answering.
- The delivery line in both seen and not-seen states, with the resume prompt.
- The withdrawn and answered-by-someone-else states.
