# Flow Spec 06: Understand why a landing failed

**Goal:** A person wants to know why an agent's landing did not land, whether it is the agent's change, and whether they need to do anything.
**Covers:** R8, R11

---

## Entry Points

- **From Needs me:** a failed check that no agent is on is a decision in Needs you.
- **From FYI:** a failed check an agent is fixing is one row.
- **From a Lane:** the Lane's Checks section shows the failed check.

---

## The Flow

### Step 1: See that it failed

**What they want:** To know what failed and whether someone is on it.

**What they see:** The Lane at checked, with the failure, who is on it and since when, or "no agent is on it".

**What they do:** Open the check.

**What happens:** The check's page opens.

### Step 2: Read the cause

**What they want:** To know why, in one line.

**What they see:** The cause where Forge can observe it, with where the fact came from ("reported by your CI"): the failing test and its first error, or a conflict with main, or a machine or infrastructure failure, or a stalled landing. Then the suspects in order: this change, main failing already, the machine, a flaky test (how often it failed on main). Unknown causes read "not reported".

**What they do:** Read the cause and the first error.

**What happens:** Nothing changes.

### Step 3: Look at the evidence

**What they want:** To check the cause for themselves.

**What they see:** The failing tests (up to three names and a remainder), the log excerpt around the first error, the exact code that was checked, and a link to the full log at the CI provider.

**What they do:** Open the log or the code.

**What happens:** The full log opens at the provider; the code opens in Code at the checked version.

### Step 4a: An agent is on it

**What they want:** To leave it to the agent.

**What they see:** The holder and its last command; the agent's own note if it posted one.

**What they do:** Nothing, or leave a note on the thread.

**What happens:** The failure stays in FYI until the Lane lands again or is abandoned.

### Step 4b: No agent is on it

**What they want:** To get it moving again.

**What they see:** Keys: Retry (recommended only when the cause is a machine or a known flaky test), Hand to an agent, and Abandon the landing.

**What they do:** Press one.

**What happens:** Retry reruns the failed part of the check; Hand to an agent copies a fix prompt with the failure in it; Abandon ends the landing with the Lane and its saves kept.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| Main itself is failing | The cause says main is failing since a named landing, and that this change is likely not the cause. |
| The CI reported no cause | The cause reads "not reported by your CI" with the log link. |
| The check never started (no runner, provider down) | The cause says the check could not start and why; see Flow Spec 24 for an outage. |
| The log is still loading | The cause and failing tests show first; the excerpt fills in when it arrives. |
| A landing stalled | The receipt names its repair command; the page shows that command, not "land again". |
| The check is still running | The page shows its progress by stage, not a percentage. |
| An empty log (the CI sent nothing) | The page says the log is empty and keeps the link to the CI's own page. |

---

## UX Notes

- A failed check an agent is fixing never asks for attention; it is FYI.
- "Main is failing" is always a suspect, shown first when it is true.
- Forge names a cause only where it can observe it; otherwise it says not reported. *(Pending Decision — Item 581bd373 question 23: Forge classifying causes so agents never choose a reason.)*

---

## Prototype Scope

- The check page with a failing test as the cause and the four suspects.
- The check page with "main is failing" as the cause.
- The check page with "not reported by your CI".
- The Needs you decision for a failed check no agent is on, with its three keys.
- The FYI row for a failure an agent is fixing.
