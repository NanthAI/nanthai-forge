# Flow Spec 32: An agent reports progress and evidence

**Goal:** A coding agent wants its person to see what it did, what it verified and what is left, tied to the Item's Done-when lines, without writing a report by hand.
**Covers:** R26, R5, R10

---

For the current save, receipt and planning-edit steps, see [Start a Lane and land it](../../guides/agents.md#land-it) and [Record Done-when evidence](../../guides/plan.md#record-done-when-evidence). This spec describes the target integrated evidence flow.

## Entry Points

- **From its own work:** after a meaningful step, after landing, or before stopping.

---

## The Flow

### Step 1: Save with a message

**What they want:** Its progress visible as it goes.

**What they see:** `save` with a message, returning the saved head, behind-main count and any conflict notice.

**What they do:** Save after each meaningful step.

**What happens:** The Lane shows the save with its summary; people see the Lane move (Flow Spec 03).

### Step 2: Report what it did not verify

**What they want:** Its person to know the limits of its work.

**What they see:** Optional report fields on save and land: what it did not verify, changes outside the code, its budget, and how soon it needs a person.

**What they do:** Fill the ones that apply.

**What happens:** The fields show on the Lane and in the Candidate summary (Flow Spec 04).

### Step 3: Land and read the receipt

**What they want:** Proof the work is on main.

**What they see:** `land --save`, then the receipt: landed or failed, the check, who accepted, the receipt id.

**What they do:** Wait with the printed command until it settles.

**What happens:** The Item's Lane shows landed.

### Step 4: Attach evidence to Done-when lines

**What they want:** Each line marked with its proof.

**What they see:** The comment write on the Item, and a way to tick a Done-when line with a receipt or a note.

**What they do:** Post one comment with the receipt and what each line rests on, and tick the lines it met.

**What happens:** The Item shows ticked lines with their evidence; when all are met, the next planning read closes it.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| The landing failed | The receipt names the cause and next command (Flow Spec 33). |
| A line was not met | The agent leaves it unticked and says why in the comment. |
| The comment failed | A structured error; retrying with the same operation id does not post twice. |
| Nothing to report yet | No save is needed until there is a meaningful step. |
| Waiting on the landing | The wait blocks up to its budget and repeats; the agent does not sleep or poll. |
| An empty report field | The person sees "not reported" for that field. |
| A slow landing check | The wait reports the stage and time so far each time it returns. |

---

## UX Notes

- One report, in the Item's thread, where the person already reads.
- *(Pending Decision — journey 33 question 3: an explicit action to tick a Done-when line with evidence.)*

---

## Prototype Scope

- None — this flow has no screen of its own; the web side is covered by Flow Specs 03 and 04, and the replies by the agent scorecard.
