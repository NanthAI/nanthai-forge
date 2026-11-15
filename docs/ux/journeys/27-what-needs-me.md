# Journey 27: "what needs me now"

One inbox for a person: approvals, questions from agents, failures and reviews, with a ping to the phone. Issue a0cf8c22 names it in the core loop. [Journey 17](17-staying-informed.md) covers notifications and the away summary; [journey 26](26-answering-an-agent.md) covers answering; this file maps the inbox item by item.

Walked: the Needs you, attention, answers, fix-notice and Home sources, the workflows doc (Now), `status` and `capabilities` (the agent's `needsFix`), and the open Issues 9e748e41 and e88f503d. **Not walked:** a rendered inbox with live items, and any decision.

## Steps today

### What can appear

| Kind | Text | Action in place | Leaves when |
| --- | --- | --- | --- |
| A landing waiting for a person (supervised project) | "Ready to accept" | Opens the Candidate review ([journey 15](15-reviewing-agent-work.md)). | Decided. |
| A Lane asks for a go | "Approval request": "Approval for Lane 1a2b3c4d waits for you" | **Review request** → approval page. | Granted, declined or withdrawn. |
| A held settings change | "Settings change waits for you (ORIGIN)" | **Review request** → "Apply this policy change?" (raw JSON today; open Issue 16093ed1). | Decided. |
| A fork pull request on the mirror | "Check run for pull request #N waits for you" | **Review request**. | Decided, or 30 days. |
| A question or message for the viewer | The agent's text, with two or three choices or a reply box. | Answer in place. | Answered. |
| Work handed to the viewer | "Handoff to you" | "Taking this handoff.", **Hand to an agent**. | Taken. |
| A failed check on a Lane | "Check failed" | **Open failing run**. | A later Candidate passes. |
| Forge reverted a landing | "Reverted from main" (failed tone), failing tests listed (at most three) | **Start a fix**, **Undo**, "Exact record". | "Until the Intent re-lands or is closed." |
| A red main traced to a landing | "Fix needed" (waiting tone) | **Start a fix**, **Close**. | The same. |
| The mirror diverged | "GitHub mirror REPO diverged": "Both heads are retained. Forge State: … Forge Git head: … GitHub head: … Expected GitHub head: …" | **Resume mirror** on Now. | Resolved. |
| A flaky test set aside | "Quarantined test: NAME": "Two supported flake verdicts occurred within seven days. This test still runs and reports…" | None found. | 20 consecutive passes. |
| A local folder is behind | "Owner folder needs refresh" | Not established in this pass. | Not established. |

### How the inbox behaves

| Behaviour | Today | Evidence |
| --- | --- | --- |
| Loading | "Reading what needs you…"; on a failed read "Can't read what needs you. Reload to try again."; "only a complete read says Nothing needs you." | source, docs |
| Partial | "Showing the most recent items only." "Some records could not be read, so this list may be incomplete." | source |
| Dismiss | **Not now** "hides one decision for the browser session … a new save, a new failure or a new notice for the same Lane or Intent shows again"; "each tab keeps at most 200". | docs |
| Count | The shell badge and the ⌘K pill count "the same visible decisions as Now, including session-local Not now choices". Home's "N need you across your projects" can be lower. | docs |
| Grouping | "Needs you groups by decision kind at scale." | docs |
| Order | Not stated in the docs or found in the source read. | |
| Across projects | No. One inbox per project. | docs |
| Outside the app | No ping. A stall alert is the only outbound signal ([journey 17](17-staying-informed.md)). | ran |
| For an agent | No equivalent read. `status` and `capabilities` carry project-wide `needsFix`. | ran |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J27-1 | S1 | **The inbox does not reach the person; the person has to reach it.** The journey's own description includes "plus phone pings". None exists for any inbox item (journey 17, J17-1). An approval can wait for hours while an agent blocks on `wait {approval}`. | ran, docs |
| J27-2 | S2 | **One list mixes decisions with status.** Approvals, questions and handoffs need the person. "Check failed" usually needs the agent, which already knows. "Quarantined test", "Owner folder needs refresh" and a diverged mirror are operator news. PRODUCT.md: "Decisions arrive as questions with answers … two or three buttons". Several kinds here have no answer to give. | source |
| J27-3 | S2 | **Items are titled by kind and id, not by what is asked.** "Approval for Lane 1a2b3c4d waits for you", "Settings change waits for you (settings)". The Item title, who asks and why are one click away. A person triaging ten items cannot rank them from the list. | source |
| J27-4 | S2 | **"Not now" forgets.** It lasts one browser session in one tab. There is no snooze until a time, no "remind me when the check passes", and the item returns on the next visit. Per-browser state also means the phone and the laptop disagree (journey 17, J17-3). | docs |
| J27-5 | S2 | **Nothing ranks or ages the list.** Items carry "recorded ages"; no rule puts a blocked agent above a week-old quarantine note. With several agents, the oldest approval is the most expensive item and looks like the others. | docs, source |
| J27-6 | S2 | **The mirror item is written in internals.** Four heads and "both heads retained" (journey 11, J11-5) in the one place a person looks for plain questions. | source |
| J27-7 | S2 | **"Fix needed" and "Reverted from main" stay until someone closes them, for everyone.** They remain "until the Intent re-lands or is closed" and count in the badge. On the Forge project three such notices were four days old and still in every agent's replies (journey 17, J17-7). A stale item teaches people to ignore the badge. | ran, docs |
| J27-8 | S2 | **Reviews of landed work are absent.** The inbox has no "landed, not yet read" (journey 15, J15-1), although the journey's description lists reviews. | source |
| J27-9 | S3 | **Three counts** (panel, badge, Home) follow different rules (journey 17, J17-4). | docs |
| J27-10 | S3 | **What a teammate with the write role sees is not stated.** The docs say owners see approval requests "that wait for them"; what a write-role member sees for a held landing they submitted is not stated. | docs |

## Dead ends

- Clearing a stale "Fix needed" without closing the Item or landing a fix.
- Snoozing an item until tomorrow.
- Seeing every project's items in one place.

## Naming and tone

- "Needs you" is a strong name and is fixed in PRODUCT.md. Inbox, attention, decisions, notices and badge are the words in source and docs.
- The honest loading and failure states are worth keeping exactly.

## What each persona needs

- **Agent, not person:** to know its request is in front of a person, and for how long it has waited; a signal when to stop waiting and do something else.
- **Person, not agent:** only what truly waits on them, the most blocking first, each answerable in place with the Item and the reason shown; a ping on the channel they choose; state that follows them across devices.

## Approved direction (group I)

These owner decisions guide the P7 spec; the steps and findings above describe the implementation observed.

- **I37:** At beta, batched email reaches a person for approvals, agent questions and handoffs; phone push comes later.
- **I40:** When the agent has stopped, the answer waits on the Lane and Forge offers a ready resume prompt. Forge never starts an agent by itself.
- **I41:** Needs you holds approvals, questions, handoffs and reviews; failures appear only when no agent is on them. Order the longest-blocked agent first.
- **I42:** Read state is kept per account so web, phone and CLI agree.
- **I43:** Home holds one inbox across projects, filterable by project.

## Questions for the owner

1. **Answered in group I:** Needs you holds approvals, questions, handoffs and reviews; failures appear only when no agent is on them. Order the longest-blocked agent first.
2. **Answered in group I:** Needs you holds approvals, questions, handoffs and reviews; failures appear only when no agent is on them. Order the longest-blocked agent first.
3. **Answered in group I:** Read state is per account (I42); a snooze time or condition remains undecided.
4. Who sees and may clear "Fix needed" and "Reverted from main", and do they expire?
5. **Answered in group I:** At beta, batched email reaches a person for approvals, agent questions and handoffs; phone push comes later. The email batching cadence remains to be specified.
6. Does the inbox include "landed, not yet read" on projects that land automatically?
