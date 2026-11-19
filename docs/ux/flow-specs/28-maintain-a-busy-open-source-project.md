# Flow Spec 28: Keep up with a busy open-source project

**Goal:** A maintainer with more incoming work than time wants to triage outside and agent-made changes and reports, stop spam, and give newcomers good first tasks.
**Covers:** R24, R7

---

## Entry Points

- **From Needs me:** fork runs and proposals waiting on them.
- **From Plan:** the triage view of reported Items.
- **From Settings:** People & access, Contributions.

---

## The Flow

### Step 1: See what came in

**What they want:** One list of everything from outside.

**What they see:** Triage: proposals and reports, each with who sent it (account age, earlier landings here, whether an agent made it), its check result if run, and its size. Sorted by trust and check result.

**What they do:** Select several.

**What happens:** Bulk actions appear: approve fork runs, decline with a reason, label, close as duplicate.

### Step 2: Let checks run

**What they want:** To spend CI only on changes worth it.

**What they see:** Approve fork run on proposals from new contributors; trusted contributors run without asking, by the project's rule.

**What they do:** Approve the runs they want.

**What happens:** The checks start on the project's CI.

### Step 3: Review and land

**What they want:** To land the good ones.

**What they see:** The proposal's review (Flow Spec 04), with an optional recommendation from their own agent's pre-review.

**What they do:** Approve and land, or ask for a change.

**What happens:** The proposal lands or waits for the contributor.

### Step 4: Stop spam

**What they want:** The flood to stop now.

**What they see:** Pause intake, and Block on any account.

**What they do:** Pause intake, or block an account.

**What happens:** No new proposals arrive while paused; a blocked account's open proposals close and it cannot send more. Both are recorded with Undo.

### Step 5: Offer starter tasks

**What they want:** Newcomers to find a first task.

**What they see:** Mark as a good first task on Items.

**What they do:** Mark a few Items.

**What happens:** The public project page lists them.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| Triage is empty | Triage says nothing is waiting from outside. |
| Hundreds of proposals | Triage loads by page with exact counts per group. |
| A blocked account had a landed change | The landing stays on main; blocking affects only new work. |
| A bulk action partly failed | The result lists which ones failed and why. |
| Loading | Groups show counts first; rows fill in. |

---

## UX Notes

- *(Pending Decision — journey 32 questions 1, 4 and 5: several approvers at beta, required flood controls before opening to proposals, and agent pre-review.)*

---

## Prototype Scope

- Triage with mixed proposals and reports.
- A bulk selection with its actions.
- Pause intake and Block, with Undo.
- Starter tasks on the public page.
- The empty triage.
