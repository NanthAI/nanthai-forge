# Flow Spec 03: Watch agents land work

**Goal:** A person who has handed work to several agents wants to see who is working on what, how far each piece has got, and what landed, without reading every change.
**Covers:** R5, R10, R27

---

## Entry Points

- **From Needs me:** they choose Lanes in the project's places.
- **From an Item:** they open the Lane that works on it.
- **From an email or FYI row:** a landing links to its Lane in History.

---

## The Flow

### Step 1: See the work in motion

**What they want:** To know who is on what right now.

**What they see:** Lanes: one row per open Lane, with its title (the Item it serves), who holds it (person, or agent session and app), where it is on the four stops (edited, saved, checked, landed) as a position, its last activity time, and any overlap with another Lane as a plain note. Lanes that wait on the reader carry a Needs you pointer to Needs me. Quiet Lanes fold to one summary line.

**What they do:** Scan the rows.

**What happens:** Rows update as saves, checks and landings arrive; nothing polls.

### Step 2: Follow one Lane

**What they want:** To see what one agent is doing.

**What they see:** The Lane: its stops with times, the changes so far (files and a short summary from the agent's saves), its checks, its thread, and who holds it with when they last ran a command.

**What they do:** Open Changes or Checks.

**What happens:** The chosen section opens in place; the address keeps it so a new tab lands on the same section.

### Step 3: See it land

**What they want:** To know when the work is on main.

**What they see:** The Lane reaches landed. The row moves to History in Lanes ("Landed today") with who landed it, whether a person approved it or it landed on its own under the project's rules, the check result and its time to main. An automatic landing carries an `auto` tag and Take it out of main.

**What they do:** Nothing, or open the landing.

**What happens:** FYI on Needs me gains one row for the landing.

### Step 4: Catch up on what landed

**What they want:** To read the important landed work later, without counting it as a decision.

**What they see:** To read, a view in Lanes listing landed changes they have not opened, newest first, with a count. It is never counted in Needs you.

**What they do:** Open one, or mark all read.

**What happens:** Read state is kept for their account across devices.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| No open Lanes yet | Lanes says nothing is in motion and offers Hand to an agent from Plan. |
| Loading | Rows keep their space while loading; no row jumps when data arrives. |
| An agent stopped mid-task | The row says when its holder last ran a command; after a while it moves to Loose ends. |
| A landing waits its turn in the queue | The row stays at checked with "waiting its turn" and its place, without a percentage. |
| The check failed | The row shows the failure and who is on it; see Flow Spec 06. |
| Two Lanes overlap | A plain note names the other Lane and the file; see Flow Spec 07 when both wait. |
| Many Lanes (over 20) | Rows group by Initiative with exact counts and open five at a time. |
| Live updates stop (tab hidden or offline) | The last values stay on screen, marked as of a time; reading resumes once on return. |
| An empty project (first time) | Lanes and History say nothing has landed yet and point to the first setup step. |

---

## UX Notes

- The four stops are a position, never a percentage.
- People and agents are named; an agent shows its session name and app, never only "Agent".
- Hidden tabs stop their live reads after a short time and resume once; idle costs nothing.

---

## Prototype Scope

- Lanes with six open Lanes at different stops, one overlap note and one Needs you pointer.
- A Lane's page with Changes open.
- History in Lanes with an automatic landing and its `auto` tag.
- The To read view with a count.
- Lanes with nothing in motion.
- Lanes at scale, grouped by Initiative.
