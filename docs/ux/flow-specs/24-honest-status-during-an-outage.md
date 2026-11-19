# Flow Spec 24: Know what is happening during an outage

**Goal:** A person wants to know, when CI, GitHub or Forge itself is down or slow, what is affected, what still works, and that nothing is lost; their agents want to know whether to wait or stop.
**Covers:** R22, R8

---

## Entry Points

- **From Needs me:** a line at the top of the project during an incident.
- **From an alert:** the incident email or alert topic.
- **From a failed check:** the cause names an infrastructure failure.
- **From the public status page.**

---

## The Flow

### Step 1: Notice the incident

**What they want:** To know something outside their code is wrong.

**What they see:** One line at the top of every project place: what is degraded (CI provider, GitHub mirror, Forge), since when, and what it affects ("Checks on GitHub Actions are not starting since 10:12. Saves work; landings wait." (draft copy)).

**What they do:** Open the line.

**What happens:** The incident page opens.

### Step 2: See what it affects

**What they want:** To know what to expect.

**What they see:** What works (saves, reads, planning), what waits (landings, mirror pushes), how many of their Lanes are waiting, and the public status page with the same facts.

**What they do:** Nothing, or tell their agents.

**What happens:** Nothing changes.

### Step 3: Agents get the same facts

**What they want:** (The agent) to know whether to wait.

**What they see:** Every reply during the incident carries one field: what is degraded, since when, wait or stop, and that its code is not the cause.

**What they do:** Wait with its landing in place, or stop and report.

**What happens:** No agent files friction or retries in a loop for the incident.

### Step 4: After it ends

**What they want:** Proof that nothing was lost.

**What they see:** The line changes to ended, with what was delayed (how many landings, how long) and that every waiting landing ran.

**What they do:** Dismiss it.

**What happens:** FYI keeps one row for the incident.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| Forge itself cannot be reached | The browser shows that Forge is not answering, the last values kept with their time, and the status page link. |
| Only one Lane's machine failed | No incident line; the failed check names the machine (Flow Spec 06). |
| The status page is loading or unreachable | The incident line still shows from the project's own read. |
| The incident is suspected, not confirmed | The line says "checks are failing to start for several Lanes" without naming a provider. |
| No incident | No line. |
| An incident with no Lanes affected yet | The line says nothing of theirs is waiting yet; the list of affected work is empty. |

---

## UX Notes

- The same facts in the app, in agent replies and on the public status page.
- *(Pending Decision — journey 30 questions 1, 2 and 6: Forge detecting incidents itself, the status page at beta, and a waiting ceiling for agents.)*

---

## Prototype Scope

- The incident line on Needs me.
- The incident page with what works and what waits.
- An agent reply with the incident field (CLI).
- The ended state with what was delayed.
- Forge unreachable in the browser.
