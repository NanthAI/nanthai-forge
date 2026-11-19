# Flow Spec 15: Understand Forge on a first visit

**Goal:** A developer who has heard of Forge wants to understand, in under a minute and before any ask, what it does for them and their agents, and what the one next step is.
**Covers:** R16

---

## Entry Points

- **From a link or search:** the public landing page.
- **From their own agent:** they pasted the public page's "Give this to your agent" prompt, and the agent explained Forge first; they come to see it.

---

## The Flow

### Step 1: Read the promise

**What they want:** To know what Forge is in one look.

**What they see:** The landing page: the tagline, one sentence on what Forge does (people and agents change the same code in parallel; every change is checked and lands; nothing is lost), and one primary action.

**What they do:** Read, or scroll.

**What happens:** Nothing is asked of them.

### Step 2: See work land

**What they want:** To see what it looks like when it works.

**What they see:** A short walkthrough of real work: one Item handed to an agent, two agents changing the same project, one check, one landing, and one moment where a person decides. It plays while in view and can be paused.

**What they do:** Watch, pause, or step through it by keyboard.

**What happens:** Each step names its word once, in order: Item, Lane, check, land, Needs you.

### Step 3: See the evidence

**What they want:** To judge whether the claim holds.

**What they see:** The measured benchmark result with its losses and its method one link away, and what it costs (the plans) with what is free.

**What they do:** Open the method, or the plans.

**What happens:** The page opens the published method; the numbers match the published report.

### Step 4: Take the one next step

**What they want:** To try it on one small change.

**What they see:** One primary action (sign in to start), and the prompt to give their agent instead.

**What they do:** Choose sign in, or copy the agent prompt.

**What happens:** Sign in opens (see Flow Spec 16); the copied prompt tells the agent to explain before it acts.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| Reduced motion | The walkthrough shows as still steps with the same words. |
| The walkthrough fails to load | The steps show as text with the same five words. |
| Slow connection | The promise and the primary action show first; the walkthrough loads after. |
| Signed in already | The primary action reads "Open your projects". |
| First-time visit on a phone | The walkthrough fits the width and steps by swipe or button. |

---

## UX Notes

- Value before any ask: no sign-up, install or import until the person chooses.
- No standing explainer later in the app; this is the one place that explains.
- *(Pending Decision — journey 34 questions 1 to 3: the walkthrough's form, whether it also runs at first sign-in, and a sample project for new accounts.)*

---

## Prototype Scope

- The landing page with promise, walkthrough and one primary action.
- The walkthrough's five steps.
- The reduced-motion still version.
- The evidence section with the method link.
- Phone width.
