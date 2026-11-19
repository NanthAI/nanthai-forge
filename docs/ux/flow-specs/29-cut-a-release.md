# Flow Spec 29: Cut a release with notes from the landings

**Goal:** A project owner wants to mark a version of main as a release and publish notes of what changed since the last one, without writing them from scratch.
**Covers:** R25

---

## Entry Points

- **From History in Lanes:** a landing's menu, Release from here.
- **From Code:** Releases.
- **From an agent's proposal:** an agent proposes a release; the owner approves it.

---

## The Flow

### Step 1: Choose the landing

**What they want:** The exact version to release.

**What they see:** The landing, its check and main's health at that point.

**What they do:** Choose Release from here.

**What happens:** A release draft opens.

### Step 2: Read the notes

**What they want:** Notes that say what changed in plain words.

**What they see:** Notes assembled from the landings since the last release, grouped by Initiative, with each Item's title and the people and agents who landed it.

**What they do:** Edit the notes, set a name (a version number).

**What happens:** The draft is saved as they edit.

### Step 3: Publish

**What they want:** The release to exist and be found.

**What they see:** Publish, and whether the tag goes to the mirror.

**What they do:** Publish.

**What happens:** The release is recorded as an immutable name for that landing; the public project page lists it; the tag reaches the mirror when chosen.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| The first release (no earlier one) | The notes cover all landings, folded by Initiative. |
| Main was failing at that landing | The draft says so before publishing. |
| The name is taken | Publish is refused, naming the existing release. |
| An agent tries to publish | It may only propose; the owner approves (Flow Spec 05). |
| Preparing the notes (loading) | The draft shows the landings first; the grouped notes fill in. |
| Publishing failed | Nothing was published and the draft is kept. |
| No landings since the last release (empty notes) | The draft says nothing landed since the last release and Publish is unavailable. |

---

## UX Notes

- *(Pending Decision — Item 581bd373 question 66: releases at beta, and whether tags are mirrored, read back, both or neither.)*

---

## Prototype Scope

- Release from here on a landing.
- The draft with assembled notes.
- Releases list in Code.
- The failing-main warning.
