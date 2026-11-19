# Flow Spec 22: Protect paths an agent may not change alone

**Goal:** A project owner wants some files (workflows, release config, security code) to land only after a person approves, and wants agents to know before they write.
**Covers:** R20, R7

---

## Entry Points

- **From Settings:** Landing & checks, Protected paths.
- **From a new project:** the default list is shown at creation.
- **From an approval page:** a held landing names the rule that held it.

---

## The Flow

### Step 1: See the list

**What they want:** To know what is protected and why.

**What they see:** Protected paths: each pattern with its reason, who it holds (agents, or everyone without approval), and who may approve (the owner, or a named team).

**What they do:** Add a pattern.

**What happens:** A field opens with a preview.

### Step 2: Add a pattern

**What they want:** To be sure the pattern matches what they mean.

**What they see:** As they type, the files at main that match, with a count.

**What they do:** Confirm the pattern and give a reason.

**What happens:** The pattern is saved and recorded with Undo. It applies to landings submitted from now on.

### Step 3: An agent writes a protected file

**What they want:** (The agent) to know before it does the work.

**What they see:** At its first write and again at save, a notice that the file is protected, who must approve, and the choice to split that part into its own Lane so the rest can land.

**What they do:** Split, or continue knowing it will be held.

**What happens:** At landing, the protected part is held for approval (see Flow Spec 05).

### Step 4: Check one file

**What they want:** To know who can change a file alone.

**What they see:** In Code, a file's details name the rule that protects it and who may approve.

**What they do:** Open the rule.

**What happens:** Settings opens at that pattern.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| A pattern matches nothing | The preview says no file matches yet and keeps the pattern. |
| Changing the list while a landing is held | The held landing keeps its decision; changing the list never releases it without one. |
| An empty list | Protected paths shows the suggested defaults to add. |
| The preview is loading | The count shows once the match has run; the pattern can still be saved. |
| Saving failed | The pattern is not saved and the field keeps it. |

---

## UX Notes

- One concept people learn; *(Pending Decision — journey 28 question 2 and journey 14 question 5: merging protected and owner-approval paths, and Zones as the one mechanism.)*
- A team may approve protected paths (owner decision 3.4).

---

## Prototype Scope

- Protected paths with reasons and approvers.
- Adding a pattern with the live preview.
- The agent's notice at first write with the split choice (CLI reply).
- A file's protection detail in Code.
- The empty list with defaults.
