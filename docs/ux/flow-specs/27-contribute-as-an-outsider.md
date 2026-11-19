# Flow Spec 27: Contribute to a project I am not in

**Goal:** A developer (or their agent) wants to send a fix or report a bug to a public project they have no role in, and see it checked and landed without paying for the check.
**Covers:** R23, R7

---

## Entry Points

- **From a public project page:** Fork, or Report a problem.
- **From their agent:** the agent's write was refused with "you have read access; to propose a change, fork" (draft copy).

---

## The Flow

### Step 1: Fork

**What they want:** A copy they can change.

**What they see:** Fork: what comes across (main and its history) and what stays behind (open Lanes, Items, stars, settings); the fork is public like its source and free.

**What they do:** Fork it.

**What happens:** The fork appears under their account with its own Lanes.

### Step 2: Make the change

**What they want:** To change the code with their own tools.

**What they see:** The fork's clone command and the usual start, save and land.

**What they do:** Make the change in a Lane of the fork and save.

**What happens:** The fork has a saved change.

### Step 3: Propose it

**What they want:** The source project to take it.

**What they see:** Propose to SOURCE on the Lane, with the project's contribution rules and limits (open proposals allowed, whether intake is paused).

**What they do:** Write a title and propose.

**What happens:** The proposal reaches the source project's maintainers; its check waits for a maintainer to approve the fork run, so the outsider pays nothing.

### Step 4: Follow it

**What they want:** To know what happens to it.

**What they see:** The proposal's page: waiting for a maintainer, check running, changes asked (with notes), landed, or declined with a reason.

**What they do:** Answer notes with new saves.

**What happens:** Each save updates the proposal; when it lands, the fork shows it on main.

### Step 5: Report a problem instead

**What they want:** To tell the maintainers about a bug without code.

**What they see:** Report a problem: title, description, and the project's template if any.

**What they do:** Write and send.

**What happens:** A Proposed Item appears in the project's triage with "reported by HANDLE".

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| Intake is paused | Propose is unavailable and the page says since when and why. |
| The outsider has too many open proposals | Propose says the limit and lists their open ones. |
| The proposal conflicts with main | The proposal says which files and asks for an update from main. |
| The fork run was declined | The proposal says the maintainer declined to run its check, with their reason. |
| Signed out | Fork and Report ask them to sign in first. |
| Sending failed | Nothing was sent; the form keeps its text. |
| No contribution rules set | The page uses Forge's defaults and says so. |
| A fork with no changes yet | Propose is unavailable until the fork has a saved change. |
| Loading the proposal | Its state line shows first; notes and checks fill in. |

---

## UX Notes

- An outsider never pays for a check on a project they do not own.
- *(Pending Decision — journey 16 questions 1 to 4: the outsider's route at beta, account requirements, public Items and who pays.)*

---

## Prototype Scope

- The fork page with what comes across.
- Propose with the project's rules.
- The proposal page in its states.
- Report a problem.
- The paused-intake and too-many states.
