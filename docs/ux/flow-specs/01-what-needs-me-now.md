# Flow Spec 01: Know what needs me now

**Goal:** A person who runs several agents on a project wants to learn, in seconds, which decisions wait on them and act on the first one. They open the project between other work.
**Covers:** R11, R7, R27

---

## Entry Points

- **From an email:** a batched email lists decisions that wait on them, each linking to Needs me.
- **From Home:** the cross-project inbox shows a count per project; they open one project.
- **From any project place:** the Needs you count in the top bar opens Needs me.
- **From a bookmark or a new tab:** the project address opens on Needs me, the project's front page.

---

## The Flow

### Step 1: Arrive

**What they want:** To know at once whether anything waits on them.

**What they see:** Needs me, with one sentence at the top that counts the decisions holding work and the longest wait, for example "3 decisions hold 4 Lanes; the longest has waited 18 min" (draft copy). Below it, three sections: Needs you, FYI and Loose ends (folded).

**What they do:** Read the sentence.

**What happens:** Nothing changes. The count in the sentence is the same number as the top bar.

### Step 2: Read the first decision

**What they want:** To understand the decision without opening anything else.

**What they see:** Needs you lists decisions longest held first. Each is a question with its answers: what is held, for how long, why it asks them, and two or three answer keys, with a recommended answer only when Forge has a fact for it. The kinds are: a landing held for their approval, a request asked of them (a fork run, a settings change, access), a question with fixed answers from an agent, a hand back to them, two Lanes that wait for each other and need an order, and a failed check that no agent is on.

**What they do:** Read the first decision's reason.

**What happens:** Nothing changes until they answer.

### Step 3: Answer in place

**What they want:** To decide and move on.

**What they see:** The answer keys of the first decision, plus a link to the full context (the Lane, the Candidate or the thread) and Later.

**What they do:** Press an answer.

**What happens:** Forge records the answer, acts on it (lands, declines, sends the answer to the agent, records the order) and shows a short confirmation with Undo where the action can be undone. The decision leaves Needs you and the count drops by one.

### Step 4: Put one off

**What they want:** To deal with one decision later without losing it.

**What they see:** Later on each decision.

**What they do:** Press Later.

**What happens:** The decision folds to one line for this visit. A new fact about the same Lane (a new save, a new failure) shows it again.

### Step 5: Glance at FYI

**What they want:** To know what moved without being asked to act.

**What they see:** FYI, newest first: landings, main breaking, checks redone, CI time thrown away, failed checks an agent is already fixing (with who is on it), settings and access changes, and messages. A few figures for the window since they last cleared it, and filters (All, Code, Outside the code, Messages).

**What they do:** Scan, dismiss one row, or Clear all.

**What happens:** Dismissed rows hide for this account on every device. A newer version of the same row shows again.

### Step 6: Tidy loose ends

**What they want:** To finish what was started and left.

**What they see:** Loose ends, folded, with a count. Unfolded: groups such as stopped mid-task, checked but never landed, Lanes nobody holds, leftover projects, waiting for a date. Each row has a "Next:" line and at most one key.

**What they do:** Press a row's key, or copy one instruction that asks an agent to tidy them up.

**What happens:** The step runs (for example the Lane is set aside with its saves kept), or the instruction is copied for the agent.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| Nothing waits on them | The sentence says nothing needs them and what landed since they were last here; Needs you shows no rows. |
| Still loading | The sentence reads that Forge is reading what needs them; no "nothing needs you" until every read has arrived. |
| A read failed or the connection dropped | A notice that Forge could not read what needs them, the last values kept, and a way to try again. An answer given offline waits on the device and says so. |
| A request asked ahead holds no work yet | It is listed under "Asked ahead" and not counted. |
| A failed check an agent is fixing | One FYI row naming who is on it and since when; not in Needs you. |
| Many decisions | The first four show, then "Show N more"; the order stays longest held first. |
| The reader cannot decide (read role) | Decisions they cannot answer are not in Needs you; the same facts appear in FYI. |
| Someone else answered first | The decision leaves the list and FYI says who answered and how. |

---

## New User vs. Returning User

- **New user:** the first three setup steps appear in Needs you as decisions (connect an agent, connect checks, land the first change), per the Setup B decision; see Flow Spec 16.
- **Returning user:** FYI marks the rows that are new since their last visit.

---

## UX Notes

- One thing, one place: a decision appears in full only in Needs you; elsewhere it is a pointer with a count.
- Answers are verbs that say what will happen. No recommendation without a fact.
- The page never explains itself; reasons sit on each decision.
- Keyboard: each decision's answers have letter keys; the first decision takes focus on arrival.

---

## Prototype Scope

- Needs me with four decisions of different kinds, longest held first.
- Needs me with nothing waiting and the "since you were last here" sentence.
- Needs me loading and "could not read" states.
- A decision answered, showing the confirmation with Undo.
- FYI with the four figures, filters and a dismissed row.
- Loose ends unfolded with a next step per group.
- Phone width: Needs you first, keys full width.
