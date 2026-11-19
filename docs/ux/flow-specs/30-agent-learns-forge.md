# Flow Spec 30: An agent learns Forge from the docs alone

**Goal:** A coding agent that has never seen Forge wants to learn enough to do one task correctly, from `llms.txt`, the docs and the CLI's own help, without reading everything.
**Covers:** R26

---

## Entry Points

- **From its person:** "use Forge for this repository" with no other instruction.
- **From the public page's prompt:** the person pasted "Give this to your agent".
- **From a refusal:** a Forge reply's `learn` field.

---

## The Flow

### Step 1: Read the start page

**What they want:** The few things it must know before acting.

**What they see:** `llms.txt`: one sentence on what Forge is, the three verbs (start, save, land), how to read help (`nforge agent ROOT --help`, `help TOPIC`), the project rules generated from the CLI contract, and links to one page per task. Its getting-started part fits a stated token budget.

**What they do:** Read it.

**What happens:** Nothing changes.

### Step 2: Explain before acting

**What they want:** (When sent by the public prompt) to tell its person what would change first.

**What they see:** The instruction to explain in a few plain lines what Forge would change, its measured results as one benchmark, and what it needs from them, before installing or changing anything.

**What they do:** Explain to its person in its own app and wait.

**What happens:** Nothing is installed until the person says so.

### Step 3: Fetch one task page

**What they want:** The steps for the task at hand only.

**What they see:** The task page (land a change, recover from a failed check, ask a person), fetched on demand.

**What they do:** Fetch it.

**What happens:** It reads only what it needs.

### Step 4: Learn from the first reply

**What they want:** To be told what applies in this project.

**What they see:** On its first command in a project, a reply under twenty lines: the three verbs, what is held for it here (protected paths, limits), and who else is working.

**What they do:** Start its task.

**What happens:** Later replies do not repeat this.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| The CLI is not installed | The start page gives the install command and says sign-in needs a person. |
| The agent uses a retired verb | The refusal names the current verb and its `learn` topic. |
| Help is fetched offline | `nforge docs` prints the same pages from the installed CLI. |
| A first contact in an empty project | The first reply says nothing is planned yet and how to propose an Item. |
| The docs page fails to load | The CLI's own help carries the same commands. |
| Loading a long reference | The reference is split by action so no fetch is the whole manual. |

---

## UX Notes

- One source generates the agent text in `llms.txt`, the skill, the CLI help and the MCP descriptions, so they cannot drift.
- Scored by the agent scorecard at the Phase 7 close: turns, tokens, errors and wrong turns.

---

## Prototype Scope

- None — this flow has no screen; its text is `llms.txt`, the skill and CLI replies, checked by the scorecard run instead of a prototype.
