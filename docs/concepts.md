# Concepts

Forge tracks two kinds of thing: **source** (the files, stored as immutable snapshots) and **work** (who is changing what, why, and with what result). Everything below is one of those.

## Core model

| Term | Plain meaning | Git analogy |
| --- | --- | --- |
| **State** | An immutable snapshot of every file (paths, content hashes, modes) plus its parent States. | commit |
| **Intent** | An outcome someone wants, with notes and a status (`active`, `ready`, `completed`, `abandoned`). | issue / PR description |
| **Lane** | An isolated working directory for one contributor to an Intent. Has a base State, a head State and checkpoints. | branch + worktree |
| **Checkpoint** | Saving a Lane's current files as a new State. | commit |
| **Sync** | Merging the latest accepted source (usually `main`) into a Lane, so the Lane sees everyone else's accepted work. | `git pull` |
| **Candidate** | An exact, pinned combination of one or more Lane heads on top of a base, ready to check and review. | merge preview / PR head |
| **Check** | A command definition (executable + arguments). A **run** records the exact Candidate, definition, environment and result. | CI job |
| **Channel** | A named pointer to accepted source, e.g. `main`. Moved by **accepting** a clean Candidate; agents require a passing exact-Candidate check, while people can accept under review. | protected branch |

The Intents UI labels open work with Lane status words (Working, Waiting, Ready, Check failed, Conflict, Stale); an active Intent that has never had a Lane is Planned, shown in a quiet neutral style. Every retained Lane counts, including completed and abandoned Lanes. Starting the first Lane uses the existing start path and the normal Lane status derivation. Planned is a presentation state; the stored Intent status remains `active` for older CLIs. Completed Intents show Done with a passed check glyph; abandoned Intents stay Abandoned.

Work has Intents, Lanes and Planning. Candidate pages remain linked from Intents, Lanes, review and history; the retired Candidates list redirects to Intents.

Work › Intents offers List and Board layouts. The URL records the layout and list filter; the browser remembers the layout per signed-in account and project. The read-only Board groups the same derived list status into Planned, Working, Checking, Ready and Done. Planned has a five-card initial page with continuation, shows linked Initiative names and omits time-in-state. Planned Intents have their own list filter and are excluded from Open and Now work counts. Planning uses the same Work row as Intents and Lanes; clicking a row opens its full page. New Intent and New Initiative open inline forms above the groups. Unassigned Proposed Intents appear before No Initiative. Initiative groups show their derived state and linked Intent counts; export remains in the header menu. History contains versions and provenance. Code always renders one frame (file tree, file, This file); a saved head in a link only sets the Source picker, which lists main, Open Lanes, Recent Candidates (newest per Intent and Lane set) and Exact head… for a pasted hash. Without a file in the URL Code opens the root README.md, else the first file. A file shows its touching Lanes under Changing this file in the file panel, hidden when none touch it. Tree dots mark files and folders an open Lane touches, coloured by the most urgent Lane. The This file column shows Changing now, Symbols and History (recent acceptances touching the file). Code files open without a selected line; explicit line links highlight their target. Syntax comments use muted text without a background. Planning lists each Initiative’s linked Intents with Planned, Working, Ready or Done states; their links open the existing Intent hand-off path. Intents and Planning filter by Proposed, Planned, In motion, Done and All, counting the rows they display (Ready is In motion, Abandoned is Done); duplicate links within an Initiative count once. Group headers report Intent totals and in-motion counts. Search matches Intent and Initiative titles. Planning uses Intent/Status columns, and export is in the toolbar’s more-actions menu. Legacy planning records keep their stored kinds and commands. Landing shares Ready because acceptance in progress has no separate recorded Intent state. Paused, needs-you and failed checks are card flags. Counts cover the loaded records and agree with the list filters; Done includes abandoned work, shows landings from the last seven days (last activity when no acceptance time is loaded), and links to the full Done list. Done cards with loaded acceptance evidence show the landing age, including combined Candidates and their exact pinned Candidate dependencies; missing acceptance evidence omits the landing age and redundant Done card label. Other cards show Lane counts, adding a landed count only for multiple Lanes with recorded landings; progress appears only for multiple Lanes. Only recorded running, passed or failed checks show a glyph. Agent initials resolve from the same session tree and actor kinds as Now, without generic workflow or missing-actor placeholders. Columns scroll separately and reveal twenty cards at a time. On phones a counted segment picker shows one column, with Done initially collapsed.

A typical change: start an Intent and Lane → edit files → `finish`, which checkpoints, syncs `main`, composes a Candidate, runs the check and accepts it. Acceptance refuses any Candidate that doesn't contain the Channel's current head, so concurrent work is merged or reported as a conflict, never dropped.

One Intent can have several Lanes. For example, start “Add search”, then use `start {"intentId":"…","outcome":"Search UI"}` for a sibling; checkpoint the sibling and `finish {"laneId":"API_LANE","with":["UI_LANE"],"message":"Add search","accept":true}` to check and land both in one Candidate. `after:{intentId}` or `after:{viewId}` records stacked work that waits for its dependency to land; rerun finish or use `land-ready`. Included Lanes complete under the lifecycle policy; the Intent completes when every Lane is done.

Intent Candidate rows show recorded changed-file counts and exact added/removed line totals when available. Missing summaries or inexact line totals remain omitted; rows reuse existing native-derived or hosted summaries.

A Candidate's provenance explains its pinned inputs and dependencies, the Lane saves that changed each file, and the Intent outcome and Forge decision/comment excerpts behind them. Optional line ranges attribute the Candidate's current lines through successive save diffs; later edits replace earlier attribution. Base lines and changed lines without recorded attribution stay distinct. Save indexes are zero-based; legacy saves without an actor remain explicitly unknown. A newer Candidate with the same Intent and Lane input identities supersedes an older candidate, while acceptance retains who landed it, when, and on which Channel. Lane participation links back to every Candidate it joined.

Merging is line-based three-way text merge. Overlapping edits, binary files and add/delete clashes become explicit conflicts for a human or agent to resolve. There is no semantic merging. Stacked Lanes and criss-cross histories with multiple shared merge bases recursively combine those bases in a deterministic order. Conflicting base variants remain available during merging; unresolved content, mode and path differences surface as normal conflicts. Original States remain unchanged.

## Projects and where data lives

- **Native project (owner)** — a directory managed by Forge without Git. Source objects and Work metadata live under `.forge/`. Lanes are materialized under `.forge/work/lane-<id>`. The optional `ownerRootUpdates` policy keeps the owner folder’s tracked files current with accepted main. It defaults off; local edits or untracked obstructions skip refresh and appear in local Needs you. `nforge owner refresh ROOT` requests the same guarded update on demand.
- **Git-backed project** — an ordinary Git repository; Forge keeps its Work metadata beside the Git data. Git and GitHub are compatibility layers, not Forge's source of truth.
- **Hosted project** — a copy of a project's source and Work in the hosted backend, so several machines and people can share it. The user's machine controls execution; native checks use the configured local or Modal backend.
- **Exchange** — pushing and pulling between a local owner and a hosted project. Only missing content is transferred.

The hosted main strip shows “Synced from <machine> <age>” only when owner reports lead the selected hosted source or an exchange is pending, adding “catching up” during the push. Its hover/focus tooltip gives recorded sync/report times and known pending work; missing names or times stay unknown. Elapsed time alone never marks a project behind. While behind, generation-derived Working/Checking statuses and check progress stay static and muted, with an as-of time. The connection no longer says Live and main’s passing check is muted. Newer completed/abandoned lifecycle metadata takes precedence over an older running check.

## Autonomy

Each project has one autonomy policy. New projects are **supervised**: agents propose checked Candidates and a person accepts them. **Trusted** permits agent acceptance after an exact-Candidate check passes. **Autonomous** also completes accepted work and cleans eligible local regenerable copies. Editing an individual setting makes the preset **custom**. Protected-path globs always require a person. Automatic actions record what changed and how to undo it; accepted history is retained and nothing irreversible is automatic.

Existing projects, including Forge's dogfooding owner, read as custom with their previous auto-accept behavior, automatic native Lane updates and completion, without enabling cleanup. See [workflows](workflows.md#autonomy-policy) for the fields and migration boundary.

## Context for agents

- **Source context** — a derived graph of files, declarations, imports and references for TypeScript, JavaScript, Python, Java and Rust. Coverage is partial and labelled; a missing edge does not prove two things are independent.
- **MCP / agent CLI** — `nforge mcp ROOT --agent` and `nforge agent ROOT …` expose source queries and the Work actions above.
- **Making-of record** — a derived, read-only account of one Intent: its Lanes, saves, check runs with queued and running time, landings, sessions, wall clock and estimated active time. Agents may self-report harness, model and token totals; absent facts are omitted, never shown as zero.
- **Coordination** — advisory live activity for a hosted project: sessions (who is working, last seen), path claims and overlaps, messages, handoffs, a per-participant inbox with acknowledgements, server-emitted related-change events and a resumable feed. It never locks files or grants access.

## Access

- **Reader / team / contributor** — who may see or propose changes to a hosted project.
- **Zone** — a pinned subset of a project's source that can be shared separately.
- **Agent grant** — a scoped, read-only token for an agent to read authorized source.
- **Secret Object** — encrypted credential versions with separate capabilities (discover, use, reveal, modify, delegate). Used only by fixed, controlled operations.

Access is always checked against current policy at read time; past access never grants new access.

## Less common

- **Playbook** — a named sequence of checks. **Invariant** — a rule a Candidate must satisfy before acceptance (e.g. named checks passed, human review).
- **Release** — a named, pinned acceptance. **Preview environment** — a draft deployment of a Candidate.
- **Operation id** — a client-generated UUID on every mutation. Retrying with the same id after an unknown outcome returns the original result instead of doing the work twice. The agent CLI generates one for you and returns it.

Abandonment closes work that will not be landed, with a reason, actor and time. It preserves every save and source State. Dirty Lane edits must be saved first; an Intent can cascade to its open Lanes. Abandoned work leaves active lists and stays readable under Done/Closed. `reopen` makes it active again; `clean` may reclaim only reconstructable local copies. See [agent workflow](agents/workflow.md#abandon-work-without-losing-it).

Direct messages to you leave Needs you and its shared badges after acknowledgement or reply, or when the sender’s linked Lane or Intent is completed or abandoned. Messages remain in the Lane conversation and Activity. Unknown or unloaded work is not treated as completed. People can acknowledge or answer messages addressed to their account or any session owned by that account; device agents must select the exact recipient session. Needs you excludes messages the viewer cannot acknowledge. Replies target the original sender’s session inbox when recorded, otherwise their participant account; agents read that inbox through the coordination CLI or MCP messages tool.

## Browser feedback

The browser app has one notification stack, at the bottom right on desktop and above the mobile navigation. Newest notifications appear first, with three visible and further errors queued. Identical messages collapse with an occurrence count. Errors stay until dismissed or retried; success and information notifications leave after six seconds. Retry is offered for reads and mutations that retain the original operation identity.

Error prose appears in notifications, including failed section reads, uploads, settings and sign-in. Failed sections keep a quiet placeholder. Forms keep typed text and associate a warning outline with the notification using `aria-invalid` and `aria-describedby`. Connection observers share one Reconnecting notification, removed when the connection recovers. Check/run status and retained log evidence remain part of the Work record.

Lane save rows show the save message, relative age and the number of files changed
against that save's parent when retained source is available. Clicking the eight-character
hash copies the full hash; the row menu holds link and source actions. Base and Head
use short hashes with source descriptions; Exact record retains full identities.
Intent and Lane work maps distinguish current, superseded, accepted and failed-check
Candidates. Candidate labels use state and age rather than Lane or save names. Each
composition column pins its saves directly above its marker, keeping connectors
local; on phones time runs downward along adjacent Lane tracks. The shared tooltip
above a marker shows its state, age, included Lanes and recorded check name when available, with an Open link. Earlier
history remains linked.
Hosted running checks without streamed output identify the recorded runner when known
and say that output appears when the check finishes. Available logs remain readable.

## Detail navigation and actions

Intent, Lane, Candidate, review and Lane source pages show linked Work breadcrumbs.
Long titles truncate while retaining their full title on hover. Detail visits add
browser history; in-page tabs, filters and Intent layouts replace the current
entry so Back returns to the previous page. Lane **Browse source** opens Code at
that Lane's latest save, with the Lane named in the Source picker.

Action menus share one popover: opening one closes the previous menu; outside
click, Escape and choosing an action close it. Arrow keys, Home and End move among
enabled actions. Destructive actions appear last. Lifecycle reasons live in a
small dialog; completion reasons are optional and retained in the lifecycle record.
