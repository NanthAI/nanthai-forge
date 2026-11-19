# Flow Spec 25: Discover a public project worth following

**Goal:** A developer, signed in or not, wants to find public projects on Forge and judge quickly whether one is alive and healthy.
**Covers:** R23

---

## Entry Points

- **From the landing page:** Explore.
- **From a search engine:** a public project page.
- **From a profile:** the person's public projects.

---

## The Flow

### Step 1: Browse

**What they want:** To see what is active.

**What they see:** Explore: public projects in the Active order (landings this week plus stars given this week, projects with passing main first), with Stars and Newest as the other orders. Each row prints the inputs of its place (landings this week, stars this week), main's health and a one-line description.

**What they do:** Change the order, or search.

**What happens:** The list reorders; search runs over names, handles and descriptions without a sign-in.

### Step 2: Filter

**What they want:** Projects in their language or with a licence they can use.

**What they see:** Filters for language, licence and main's health.

**What they do:** Choose filters.

**What happens:** The list narrows; the address keeps the filters.

### Step 3: Open a project

**What they want:** To judge it.

**What they see:** The public project page: description, main's health (passing, failing for how long, or not checked) with the last 40 landings as a strip, counts of open Lanes at each stop (titles only when the project opts in), the plan's progress and the next few Item titles unless the project keeps the plan to members, stars, and Browse the code.

**What they do:** Browse the code, or star (Flow Spec 26).

**What happens:** Code opens read-only (Flow Spec 13).

### Step 4: Get the code

**What they want:** To clone it.

**What they see:** Clone, which asks them to sign in; after sign-in, the clone command.

**What they do:** Sign in and copy the command.

**What happens:** The terminal asks for device approval once.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| No results | Explore says nothing matched and offers to clear filters. |
| A private or missing project address | "No project here", the same for both, with Sign in. |
| A project that lands without checks | Its health reads "not checked", never passing. |
| The page is a still from the last landing | Every figure says "as of the last landing" with its time. |
| Loading | Rows keep their space while the cached pages load. |
| An empty Explore (first projects) | Explore lists what exists, newest first. |
| The cached list failed to load | Explore says it could not load the list and offers to try again. |

---

## UX Notes

- Signed-out pages never reach the backend; they read cached pages.
- No hand-picked or paid slots at launch.
- A landing shows the person's public handle and "by an agent" when an agent landed it; never the agent's or session's name.

---

## Prototype Scope

- Explore in Active order with filters.
- A public project page.
- The clone prompt for a signed-out visitor.
- "No project here".
- No results.
