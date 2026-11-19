# Flow Spec 33: An agent recovers from a failed check or a stale Lane

**Goal:** A coding agent whose landing failed, or whose Lane fell far behind main, wants to get its work landed again in the same Lane with the fewest turns.
**Covers:** R26, R8

---

## Entry Points

- **From a failed landing receipt.**
- **From a save or start reply:** a large behind-main count or a conflict notice.
- **From the turn-end hook:** its work is still running and the hook names the wait command.

---

## The Flow

### Step 1: Read the cause

**What they want:** To know whether it is its change.

**What they see:** The receipt: the cause where Forge can observe it (failing tests and the first error, conflict with main, machine failure, stall), the suspects including main failing already, and one next command.

**What they do:** Read the first error.

**What happens:** Nothing changes.

### Step 2a: Its change broke a test

**What they want:** To fix it where it is.

**What they see:** The failing test names and the exact checked code.

**What they do:** Fix in the same Lane, run the targeted test, save, and land again.

**What happens:** A new landing starts from the same Lane; the person sees "fixing" in FYI, not in Needs you.

### Step 2b: A conflict with main or the Lane ahead

**What they want:** To resolve it once.

**What they see:** The conflict files and the reply's Recommended command, with what a resolution depends on.

**What they do:** Follow the Recommended command.

**What happens:** The Lane updates from main (or resolves against the Lane ahead), and lands again.

### Step 2c: Not its change (machine, main failing, stall)

**What they want:** To not waste a turn on its code.

**What they see:** The cause says its code is not the cause, and the next command: retry, wait for main, or the stall's repair command.

**What they do:** Run that command.

**What happens:** The landing continues or waits; no new Lane is started.

### Step 3: Stay with it

**What they want:** To see it land.

**What they see:** The printed wait command.

**What they do:** Wait in the foreground until terminal.

**What happens:** The receipt arrives; the agent reports (Flow Spec 32).

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| The same test fails twice | The receipt says it failed twice on this Lane and suggests asking a person (Flow Spec 34). |
| A stalled landing | The receipt names its repair command; the agent runs that and does not resubmit. |
| The Lane is very stale | The start or save reply says how far behind and that `land --save` updates from main. |
| The shell was killed mid-wait | The original operation's wait command resumes it. |
| An empty error (no cause reported) | The receipt says "not reported" and gives the log link. |
| Recovery failed again | The next receipt names a different command or asks for a person; it never loops. |
| Waiting for the log (still loading) | The receipt gives the cause first; the log link works once the CI has stored it. |

---

## UX Notes

- Fix in the same Lane; never cancel and start a new Lane.
- Every refusal carries `next` and `learn`.

---

## Prototype Scope

- None — this flow has no screen; its receipts and replies are checked by the agent scorecard at the Phase 7 close.
