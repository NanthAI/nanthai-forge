# Flow Spec 02: Hand a planned Item to an agent

**Goal:** A person wants an agent to start work on a planned Item without writing a prompt by hand. They have chosen the Item from the backlog.
**Covers:** R4, R27

---

## Entry Points

- **From an Item:** they open a Planned Item and choose Hand to an agent.
- **From Plan:** a row's menu holds Hand to an agent.
- **From Loose ends:** a stopped Lane offers its resume prompt (the same sheet, resume form).

---

## The Flow

### Step 1: Choose to hand it over

**What they want:** To give this Item to an agent now.

**What they see:** The Item: its title, its Done-when lines, its Initiative, and Hand to an agent as the primary action.

**What they do:** Choose Hand to an agent.

**What happens:** A sheet opens with a prepared prompt built from the Item.

### Step 2: Check the prompt

**What they want:** To be sure the agent will get the right task and nothing more.

**What they see:** The prompt in short form: the Item id and title, the one command that starts the Lane, the Done-when lines, and a line that tells the agent where to read the rest. The full prompt text is one disclosure away. A field for one added note that is kept on the Item.

**What they do:** Optionally add a note.

**What happens:** The note is added to the prompt and saved on the Item's thread.

### Step 3: Copy it

**What they want:** To paste it into their agent app.

**What they see:** A copy key, and the connected agent apps with the one command for each when an app is not yet connected (see Flow Spec 16).

**What they do:** Copy the prompt and paste it into their agent app.

**What happens:** The key confirms the copy. The Item shows "Handed over, not started" with the time.

### Step 4: See it picked up

**What they want:** To know the agent took it.

**What they see:** On the Item and on Plan, the state changes to In progress when the agent's first `start` opens a Lane on it, with the session name and app that holds the Lane.

**What they do:** Nothing; or open the Lane.

**What happens:** The Item links to its Lane. Activity records who started it.

### Step 5: Notice when it is not picked up

**What they want:** To know if the hand-over went nowhere.

**What they see:** If no Lane starts, the Item keeps "Handed over, not started" with its age; after a while it moves to Loose ends with a next step.

**What they do:** Copy the prompt again or hand it to another agent.

**What happens:** A new copy is recorded; no Lane is created by Forge.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| The Item is Proposed | Hand to an agent offers to plan it first (one press), then the sheet opens. |
| The Item already has an open Lane | The sheet offers the Lane's resume prompt instead, naming who holds it. |
| The copy failed (browser refused clipboard) | The prompt text is selected in place with an instruction to copy it by hand. |
| The prompt is still being prepared | The sheet holds space for it and reads that it is preparing; the copy key waits. |
| The Item has no Done-when lines | The prompt says so and asks the agent to propose them first. |
| First time: no agent app connected yet | The sheet shows the connect step for each app before the copy key. |

---

## UX Notes

- Forge never starts an agent. Every word on the sheet says "copy" and "paste", never "send" or "run".
- The prompt is short enough that an agent keeps it; detail is fetched by the agent when needed.
- *(Pending Decision — journey 25 question 3: assigning an Item to a named agent or person before any Lane exists.)*

---

## Prototype Scope

- The Item with Hand to an agent.
- The hand-over sheet with the short prompt, the full-prompt disclosure and the note field.
- The Item in "Handed over, not started" and then In progress with its holder.
- The sheet's resume form for an Item with an open Lane.
- The clipboard-refused state.
