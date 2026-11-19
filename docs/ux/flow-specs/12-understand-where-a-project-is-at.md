# Flow Spec 12: Understand where a project is at

**Goal:** A person (or a lead agent reporting to one) wants to know how far along the project or a phase is: what is done, in progress, left and stuck, and whether main is healthy.
**Covers:** R10, R3, R5

---

## Entry Points

- **From Home:** each project row carries a short status line.
- **From Plan:** each Initiative's roll-up.
- **From Stats:** the project's trend over time.

---

## The Flow

### Step 1: Read the one line

**What they want:** The answer in one sentence.

**What they see:** On Home and at the top of Plan, one line per project or Initiative: how many Items are done, how many in progress, how many wait on them, how many not started, and main's health ("14 of 19 done, 3 in progress, 2 waiting on you; main passing" (draft copy)).

**What they do:** Read it.

**What happens:** Nothing changes.

### Step 2: See what is stuck

**What they want:** To know what is not moving and why.

**What they see:** A "stuck" count beside the line. Opened, it lists Items in progress whose Lane has had no save for a set time, and Lanes held for a person, each with its reason and age.

**What they do:** Open a stuck Item.

**What happens:** The Item opens with its Lane and reason; anything waiting on them links to Needs me.

### Step 3: Check main

**What they want:** To know whether main can be trusted.

**What they see:** Main's health: passing, failing since a named landing, or not checked, with the last landings as a short strip where a landing taken out of main stands out.

**What they do:** Open a failing landing if any.

**What happens:** The landing opens in History.

### Step 4: See the trend

**What they want:** To know if the project is speeding up or slowing down.

**What they see:** On Stats: landings per day against Items added, time to main and first-try rate over recent weeks.

**What they do:** Change the window.

**What happens:** The figures redraw for the window.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| A new project with nothing landed yet | The line says nothing has landed yet and points to the first setup step. |
| No checks connected | Main's health reads "not checked", never "passing". |
| Counts still loading | The line keeps its space and fills in once; no partial count is shown as final. |
| A read failed | The line says Forge could not read the status and keeps the last known one with its time. |
| No Initiatives | The line covers the whole project; Items without an Initiative count under No Initiative. |
| An empty stuck list | The stuck count is absent; nothing is shown as stuck. |

---

## UX Notes

- The same numbers in every place they appear; one read serves Home, Plan and agents.
- *(Pending Decision — journey 38 question 2: the exact rule for "stuck".)*

---

## Prototype Scope

- The status line on Home and on Plan.
- The stuck list opened.
- Main's health strip with a landing taken out.
- Stats with the trend figures.
- The new-project and not-checked states.
