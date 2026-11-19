# Flow Spec 26: Star a project

**Goal:** A signed-in developer wants to mark a project they like so they can find it again and show the owners it is valued.
**Covers:** R23

---

## Entry Points

- **From a public project page:** the Star action.
- **From Explore:** a row's star.

---

## The Flow

### Step 1: Star it

**What they want:** To keep this project.

**What they see:** Star with the public count.

**What they do:** Press Star.

**What happens:** The star is recorded on their account and the count rises by one; pressing again removes it.

### Step 2: Find it again

**What they want:** Their starred projects in one place.

**What they see:** On their own profile, Starred (shown only to them), newest first.

**What they do:** Open one.

**What happens:** The project page opens.

### Step 3: The owner sees it

**What they want:** (The owner) to know who values the project.

**What they see:** On the project's Stats, stars over time, and the list of people who starred (owners only).

**What they do:** Open the list.

**What happens:** Nothing changes.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| Signed out | Star asks them to sign in, then stars. |
| Starring failed | The star returns to its earlier state and a notice says so. |
| No stars yet | Starred says they have starred nothing yet and links to Explore. |
| The project became private | It stays in their Starred list as "no longer available". |
| Loading the list | Rows keep their space. |

---

## UX Notes

- The count is public; the list of people is for owners only; a profile's Starred list is for its own person.
- No follow at launch.

---

## Prototype Scope

- Star on a project page, before and after.
- Starred on a profile.
- The owner's list of stargazers.
- The signed-out prompt.
