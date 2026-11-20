# Journey 10: mistakes and recovery

An undo, a wrong Lane, abandoned work and a lost local checkout.

Walked: `status` (clone root and agent), `help lanes`, `help retry`, `help land`, `x revert --help`, `policy`, `nforge settings`, the revert, Needs you and project lifecycle sources, and the workflow guide's snapshot and abandon sections. **Not walked:** a revert, a snapshot restore, an abandon, a reopen and a project delete (each changes the project).

## Steps today

| Mistake | Agent | Person |
| --- | --- | --- |
| **A landing was wrong** | `nforge x ROOT revert '{"target":{"kind":"receipt","receiptId":"…"},"message":"…"}'`. It prepares a reverse Lane and lands it through the same check and queue. Main is never rewound. (ran: help, docs) | Candidate page → **Revert…** opens an inline confirmation with an optional Why. Later landings that do not overlap stay. (docs) |
| **Forge reverted a landing itself** (main audit, fast mode) | Its Lane keeps the change; a notice says "reverted on main after it landed; its Lane keeps the change". | Needs you: "Reverted from main" with **Start a fix**, **Undo** and "Exact record". The away strip offers "How to undo". (source) |
| **A landing in flight should stop** | `land --withdraw '{"reason":"…"}'`, then the confirm wait returns `LANDING_CANCELLED`; or `x cancel '{"submissionId":"…"}'`. The Lane and its saves stay. (ran: help) | **Cancel landing**. |
| **Unsaved edits went wrong in a Lane** | `x snapshots '{}'` lists the Lane's snapshots; `{"undo":N}`, `{"redo":N}`, `{"restore":SEQ or "latest"}` write files back. Each move snapshots first. Needs the project policy `autoSnapshot` (off unless set). Snapshots expire 14 days after the Lane's latest. (docs) | No web equivalent. |
| **A saved step should be undone** | No action. Edit again and save. Open Issue e7812d8f (Lane-level undo). | n/a |
| **Edits made in the wrong Lane** | `x abandon '{"laneId":"…","reason":"…","keepPatch":true}'` keeps the unsaved edits as a patch file next to the checkout; apply it in the right Lane with `patch -p1`. `LANE_NOT_ACTIVE`: "the Lane landed or was abandoned; keep your edits and start a new Lane." (ran: help, docs) | n/a |
| **Edits made in the clone root** | `pull` refuses tracked edits and names a Lane as the next step. Kept changes appear in `status` under `keptApply`: "Your local changes are kept here, not in the Lane head, until the expiry time. Copy back what you need, then save." (ran) | n/a |
| **Work will not be landed** | `x abandon '{"laneId":"…","reason":"…"}'`; nothing is deleted. `start --reopen` restores it. `x abandon-dormant` dry-runs, and with `apply:true` abandons at most 25 Lanes idle past `dormantAfterDays` (default 2). (ran: help) | Lifecycle actions ask for a reason in a small dialog; abandoned work shows grey under Done. (docs) |
| **Local folders pile up** | `nforge prune [--apply]`; `autoPruneHours` (3) removes roots of landed or abandoned Lanes; an open Lane's root is kept 168 hours. (ran) | n/a |
| **The local checkout is gone** | `nforge clone` again; `start --open '{"laneId":"…"}'` brings a Lane back at its last save; with snapshots on, `x snapshots '{"restore":"latest"}'` brings back unsaved files. (docs) | n/a |
| **A reply was lost** | Replay the same command with the same `operationId`; it returns the original result. `wait '{"operationIds":["…"]}'` resumes. (ran: help) | Notifications keep **Retry** for operations that retain their identity. |
| **The project was deleted** | n/a | "Project deleted. You can restore it here for 90 days." **Restore project**: "Project restored with its source and Work. Grant access and register runners again." **Delete permanently now** is separate. (source) |
| **A device is lost** | `nforge logout` | Signed-in devices → revoke: "Stops working now." |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J10-1 | S2 | **Undo is five mechanisms with five verbs.** Revert (a landing), withdraw or cancel (in flight), snapshots undo, redo and restore (unsaved files), abandon and reopen (a Lane), restore (a project), and Undo (an automatic action on the web). PRODUCT.md promises "Undo next to every automatic action" and "never loses anything"; the CLI has no command named undo outside snapshots. | ran, source |
| J10-2 | S2 | **Everyday recovery sits in the operator namespace.** Abandon, cancel, revert, snapshots and complete are `nforge x` actions, described as "operator and repair actions". AGENTS.md tells every agent to "abandon work you will not land". An agent taught three verbs has to find a fourth namespace for a routine step. | ran, docs |
| J10-3 | S2 | **Unsaved work is unprotected by default.** `autoSnapshot` is "off unless set". On a default project an agent that crashes loses everything since its last save; the 30-minute save nudge is the only guard. The Forge project has it on. | docs, ran |
| J10-4 | S2 | **The revert target is not said in the action list.** `x revert: message?, target` gives no hint that the target is a landing receipt; the schema behind `--help` does. The default message is "Agent change". | ran |
| J10-5 | S2 | **Moving edits to another Lane is manual.** Keep a patch, start a Lane, run `patch -p1`. The tool must exist on the machine, and the path of the patch file comes from the abandon receipt. | docs |
| J10-6 | S2 | **`status` at the clone root lists every kept folder, readable only by a program.** Each entry has a full local path and times as epoch milliseconds (`"expiresAt":1794873952028`). Entries with no edited, extra or deleted files are listed too: three of the first six. | ran |
| J10-7 | S2 | **A saved step cannot be undone.** Snapshots cover unsaved files; revert covers landings; nothing takes a Lane back to an earlier save. Open Issue e7812d8f. | ran |
| J10-8 | S3 | **`nforge status` and `nforge agent ROOT status` share a name and differ entirely.** The first prints "Forge clone: current with main."; the second prints about 3.7 KB of JSON. The split is useful (one for people, one for agents) and is the only command where it exists. | ran |
| J10-9 | S3 | **A restored project comes back without access or runners.** "Grant access and register runners again." The delete dialog does say so beforehand ("grants and runner registrations are not restored"), names what is purged after 90 days, and asks for the project name to be typed only for **Delete permanently now**. This dialog is the model for the other recovery flows; the cost is the re-invite work after a restore. | source |
| J10-10 | S3 | **The checkout depends on a sibling folder.** "Keep ROOT and its `.forge-client` sibling together." What a person sees after moving one without the other was not walked. | docs |

## Dead ends

- Undoing a saved step (J10-7).
- A crash on a project without snapshots (J10-3): nothing to restore, and no reply says so until the agent looks.

## Naming and tone

- Web: Revert…, Undo, Cancel landing, Restore project. CLI: revert, withdraw, cancel, abandon, reopen, snapshots undo/redo/restore, prune, recover-apply. Docs add clean, complete and complete-merged.
- "Abandon" is a heavy word for "I will not land this". The web's result label is quieter: "Closed without landing".

## What each persona needs

- **Agent, not person:** exact commands in the failure reply (present for most); a rule for when to abandon versus fix (present in the rules); protection of unsaved work without having to know a policy flag.
- **Person, not agent:** one word (Undo) wherever something automatic happened, and confidence that nothing is gone. The web holds to this for landings and projects. A person has no window into Lane snapshots.

## Questions for the owner

1. Should automatic snapshots be on for every project by default? The cost is one call and one upload per changed snapshot.
2. Should `abandon`, `revert` and `cancel` move out of `nforge x` and sit beside start, save and land?
3. What does Lane-level undo (e7812d8f) cover: back to an earlier save, or also undoing a sync?
4. Should "abandon" be renamed (close, drop, set aside) when the web is redesigned?
