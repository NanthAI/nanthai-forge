# Flow Spec 18: Set up checks with my own CI

**Goal:** A project owner wants every landing checked by the CI they already use, with a try before the first landing depends on it, and to know who pays for the minutes.
**Covers:** R18, R20

---

## Entry Points

- **From a setup decision:** Connect checks in Needs you.
- **From Settings:** Landing & checks.
- **From a held landing:** a landing that cannot be checked links here.

---

## The Flow

### Step 1: Say which CI they have

**What they want:** To start from what they already use.

**What they see:** "Which CI do you use?" (draft copy) with GitHub Actions, another CI, or a machine they run, and that minutes are paid by their CI account, not Forge.

**What they do:** Choose one.

**What happens:** The steps for that CI appear.

### Step 2: Add the trigger

**What they want:** Their CI to run on Forge's landings.

**What they see:** The one trigger line to add to their CI file (or the command for a machine they run), and that the first landing will be this line, checked by their CI and approved by them.

**What they do:** Copy the line, or let an agent add it.

**What happens:** Forge prepares a Lane with that change; the agent's prompt is ready when they chose an agent.

### Step 3: Try the check

**What they want:** To see a check pass before relying on it.

**What they see:** Try the check, which runs the check on main as it is.

**What they do:** Press Try the check.

**What happens:** The check runs; the page shows it started at their CI, its stages, and the result with a link to the CI's log.

### Step 4: Land the first change

**What they want:** The setup itself to be the first landing.

**What they see:** The trigger Lane, checked by their CI, held for their approval.

**What they do:** Approve and land.

**What happens:** It lands; the setup decision leaves Needs you.

### Step 5: Choose who approves next

**What they want:** To decide how much to hand over.

**What they see:** One question, once: "Who approves the next landings?" (draft copy) with "Land on its own when the check passes" suggested, and "I approve each one".

**What they do:** Choose.

**What happens:** The choice is set in Landing & checks and can be changed there.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| The trial check never reports | After a set time the page says the CI did not report, lists the likely causes, and keeps the line to fix. |
| The trial check fails | The result shows the cause (see Flow Spec 06); landing still works once it passes. |
| A check needs secrets | The page links to Secrets for checks (Flow Spec 21). |
| No CI yet | The page offers a starter check file for GitHub Actions. |
| The CI's log is private | The page says logs stay at the CI and who can read them. |
| Waiting for the check to start | The page says it is waiting for the CI to pick it up, with the time so far. |
| Loading the CI choices | The step keeps its space; the choices show once the project's state has loaded. |

---

## UX Notes

- The CI the project already has is the default route; Forge's own runner is an option, not a requirement.
- Checks work with any CI; no step assumes GitHub.

---

## Prototype Scope

- The "which CI" step.
- The trigger line step with the agent option.
- Try the check: running and passed.
- The first landing held for approval.
- The "who approves next" question.
- The never-reports state.
