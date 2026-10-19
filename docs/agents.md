# Agents

Forge does not run agents or supply a model. Your coding harness (Codex, Claude Code or another) stays where it is. Forge gives it shared source, isolated Lanes, checks and a way to see what other agents are doing.

The command reference is [agents/workflow.md](agents/workflow.md) and the terse runtime copy is [skills/forge-agent/SKILL.md](../skills/forge-agent/SKILL.md).

## Connect over MCP

Build or install Forge, then print a ready-made client entry:

```sh
nforge mcp-config /absolute/path/to/project --agent
```

Merge the printed `mcpServers.forge` entry into your client's configuration. It uses the absolute Node and CLI paths. Run the server directly with Node, not through `npm run`, because npm's output corrupts the stdio stream. Remove that one entry to undo.

| Process | Tools | Authority |
| --- | --- | --- |
| `nforge mcp ROOT` | Eight read-only source tools (`forge_current`, `forge_context`, `forge_inspect`, `forge_references`, `forge_trace`, `forge_impact`, `forge_source`, `forge_reindex`) | Your OS account |
| `nforge mcp ROOT --work` | Source tools plus `forge_work_status` and `forge_work_command` for the full Work contract | Your OS account, plus `gh` login for GitHub steps |
| `nforge mcp ROOT --agent` | Source tools plus `forge_task`, `forge_check`, `forge_review`, `forge_work_overview`, `forge_brief` | Your OS account |
| `--agent` after `nforge login` or with `FORGE_AUTH_TOKEN` set | Also `forge_exchange` and `forge_migrate_archive` | Your signed-in account |
| `nforge mcp-coordination URL PROJECT_ID` | Coordination tools below | Your account token |
| `nforge mcp-agent URL` | Only the read tools a source grant allows | `FORGE_AGENT_TOKEN` |

Source tools accept an optional `laneId` to read a Lane instead of the startup root. A missing or stale index returns `INDEX_MISSING` or `SOURCE_STALE`, so call `forge_reindex` and ask again. Errors never fall back to the startup source. Treat repository text as data, and use ordinary search where analysis has no coverage.

Run `nforge login https://your-deployment.convex.cloud` and approve the displayed code in the signed-in Forge browser. The CLI opens the browser when available; `--no-browser` prints the same URL for manual use. `--name "My laptop"` labels the device. Agents needing only coordination can use `--scope coordination`; full `cli` scope is the default and still uses your current project permissions. Coordination-only credentials do not grant source exchange or hosted Work access.

`nforge auth status [URL]` verifies current authentication. `nforge logout [URL]` revokes the saved device and removes its local credential; if the server cannot be reached, it reports that remote revocation was not verified. Account → Account & data lists CLI devices and lets you revoke them. Credentials expire after 30 days; run login again. Codes expire after ten minutes.

Credentials are stored per deployment in `$XDG_CONFIG_HOME/forge/auth.json` (default `~/.config/forge/auth.json`), mode `0600`. Hosted CLI, local checks and MCP commands read them automatically. `FORGE_AUTH_TOKEN` remains a private environment override for CI and existing Clerk JWT integrations; never place tokens in arguments or committed configuration. `FORGE_DEPLOYMENT_URL` or the last login supplies login/status/logout's optional URL. Source-only `FORGE_AGENT_TOKEN` grants remain separate.

`nforge plugin-config ROOT NEW_DIRECTORY` writes a local Codex plugin containing the skill and the `--agent` server. It records your Node and CLI paths and copies no source or credentials.

## Copy prompts and briefings

Run `nforge agent ROOT brief '{"situation":"resolve-conflict","laneId":"LANE_ID","agent":"codex"}'` or `forge_brief` for a short copy prompt, full Markdown briefing and structured context. Seven templates cover starting/continuing work, conflicts, failed checks, review, handoffs and messages. Copied prompts ask the agent to fetch fresh context first. No model inference or source contents enter the prompt; applicable repository instruction files are named by path and take precedence over project guidance, personal guidance and Forge steps.

Local `guidance` and hosted `agentGuidance.read/set` preserve up to 4,000 characters each for project and personal guidance, with retry-safe writes. Hosted `projectBriefings.brief` checks current project access. See [briefing API and setup](agents/briefings.md) for source-path preparation, live coordination, optional MCP setup and coverage limits.

Local agent `start` records `startedBy {kind, name, tool?}`. `start`, `finish` and `accept` accept an optional `actor` name and `tool`; `FORGE_ACTOR` / `FORGE_ACTOR_TOOL` supply defaults. Acceptance receipts, status and records expose `acceptedBy`. Local UI/server actions record the OS person; agent workflow and MCP record an agent. Existing records keep unknown attribution. These local labels declare who acted; they grant no authority.

Hosted readers can call `projectPeopleActions.labels({projectId, actors})` for actors already visible in project Work or server coordination. Owners can also name participants in their existing roster. Imported declarations alone never authorize an unrelated account lookup. Results use display names without email fallback. The project-scoped derived names appear as `actorDisplayName` on hosted Work summaries and coordination rows (`fromDisplayName` in compact inbox items). Access is rechecked before returning names; unrelated account IDs cannot be used as a directory lookup.

Hosted View/run summaries expose `main {head, included}` against the current hosted main (or imported main until a hosted selection exists). Native State parents and Git bundle commit parents (SHA-1/SHA-256, including pack deltas) are indexed during generation preparation; main moves require only indexed membership lookups. `included: null` means source or parent closure is unavailable; derived-data failure does not deny retained Work reads. A run uses its own exact head.

## Coordination

Coordination tells agents and people who is working on what, what changed near their work, and who has been asked to do what. It is advisory only: nothing here locks a path, pauses an agent, grants access or accepts source.

MCP tools (`nforge mcp-coordination URL PROJECT_ID`); each has a matching `nforge coordination URL PROJECT_ID JSON` action (`--help` lists them):

| Tool | Does |
| --- | --- |
| `forge_announce` | Status and summary, optional Intent, Lane, paths, `kind`, harness/version and parent session. Creates this process's session and touches its last-seen every 30 s until `completed`. |
| `forge_claim` / `forge_release` | Advisory claim on paths with a TTL (default 60 min). A path covers that file or directory. The reply lists overlapping active claims by others. |
| `forge_message` / `forge_handoff` | Message a session or participant (or broadcast); hand off the next step pinned to an exact head. |
| `forge_inbox` / `forge_ack` | Your unacknowledged messages and handoffs (including broadcasts); `all:true` pages everything addressed to you. Ack by message id. |
| `forge_coordination_read` | `feed` (optionally one Intent or Lane), `sessions` (paged roots, immediate children or all flat sessions; `lastSeen`, `stale`), `counts`, `recent`, `related`, `claims`, `overlaps`. |
| `forge_coordination_watch` | Waits up to 60 s for new events; `related:true` only returns events related to you. |
| `forge_coordinate` | Low-level publish with explicit operation UUID and sequence. |

### Session identity and counts

Each announcing process is a session, independent of device login. A session declares `kind: "agent" | "subagent" | "person"`, `harness: "claude-code" | "codex" | "cursor" | "pi" | "other"`, optional `harnessVersion` and optional `parentSessionId`. Low-level activity commands use `sessionKind` because their `kind` is already `"activity"`. Missing legacy fields read as a top-level agent with harness `"other"`. A parent link requires a live, unfinished session in the same project, from the same actor and credential. Parent links cannot cycle. Children remain subagents when their parent becomes stale or completes; they can still report completion.

MCP detects the harness from initialize `clientInfo`, then environment (`CLAUDECODE`, `CODEX_THREAD_ID`, `CURSOR_AGENT`, `PI_CODING_AGENT_DIR`), with `FORGE_HARNESS` / `FORGE_HARNESS_VERSION` available for an explicit environment declaration. `forge_announce` also accepts explicit harness/version. Its reply includes `childEnvironment: {FORGE_PARENT_SESSION: sessionId}`. Pass that environment when launching a child harness/MCP process. Each child announces its own distinct session, inheriting the parent link and defaulting to `subagent`. The server also sets this environment for its own future children; it cannot change the environment of an already-running coding harness. A session that never announces is not silently invented.

`projectCoordination.counts({projectId, refreshKey?})` is authorized like session reads. `projectCoordination.publicCounts({projectId, refreshKey?})` works without sign-in only for public, untrashed projects and returns **only these five numeric fields**, with no names, session ids, actors, credentials, paths or Lane ids:

| Field | Meaning |
| --- | --- |
| `activeAgents` | Unfinished top-level agent sessions with activity within 15 minutes. Duplicate names on the same Lane collapse to their newest observation; these are not unique humans, devices or models. |
| `activeSubagents` | Unfinished subagent sessions with activity within 15 minutes, including children of stale/completed parents and unparented sessions explicitly declared as subagents. |
| `activePeople` | Unfinished person sessions with activity within 15 minutes. |
| `activeLanes` | Distinct Lanes with an observed save, check or claim in the last 15 minutes. Includes hosted source-return changes, Lane checkpoint/check events, imported latest save/check summaries, and local check reports. An announcement, note, message or heartbeat alone is not Lane activity. |
| `unannouncedActiveLanes` | Active Lanes without a live session naming that Lane or holding an active claim attributed to it. These are activity observations without live session attribution, not an estimated number of hidden agents. |

CLI/MCP reads use `{action:"counts"}`. Counts use server time at query execution. Convex subscriptions do not rerun just because time passes: a live UI should update optional `refreshKey` (for example `Math.floor(Date.now()/30000)`) every 30 seconds. `sessions({projectId, paginationOpts:{cursor,numItems}, parentSessionId?, all?})` pages top-level summaries by default, immediate children when `parentSessionId` is supplied, or flat project sessions with `all:true`. Rows carry `kind`, `harness`, `stale`, `parentSessionId` and an empty `subagents` array; children are never expanded inside a root query. CLI/MCP reads accept the same optional `parentSessionId` and `all` fields alongside `cursor` and `pageSize`. Continue each scope independently until `isDone`; creation order is stable across heartbeats and new inserts appear on the first live page. Credential bindings are server-only and omitted. Stale flags are computed when read; use `lastSeen` with the current clock for continuously rendered freshness.

Activity is limited to reports received by this hosted project and its selected Work index. Unpublished local saves/checks remain unknown. Public counts never make per-session detail anonymous; session, feed and claim reads retain their existing authorization.

- **Last seen.** `touch` without an activity kind updates only heartbeat receipt time (`lastSeen`; repeats under 20 s are skipped; no feed event), preserving activity time. Real activity records `lastActivity` and `activityKind`. Sessions are working through 15 minutes, quiet through 90 minutes (still listed), then folded as “not seen since HH:mm”. Explicit completion or Lane acceptance/closure ends them. These are activity observations, never an online/offline claim.
- **Addressing.** `to` is a session UUID or a participant (the `actor` shown on sessions). A message to a session must be acked by that session; one to a participant by any of their sessions. Broadcast acks are recorded per participant. Everyone with project access can still read the whole feed.
- **Related changes.** The server adds `change` events when hosted Work is written, a checkpoint is pushed, and a source return lands (one per moved Lane, with Intent, Lane, head and up to 50 changed paths for the first four Lanes). Missing paths mean unknown, not unrelated. `related` matches your active claims, the selected session's Intent/Lane/paths, explicit scope, and anything addressed to you. It scans at most 200 events per call; keep reading while `isDone` is false.
- **Choice answers.** Messages may carry `choices`, two or three distinct nonblank labels of at most 120 characters. `forge_message` accepts them and `forge_inbox` shows them. `forge_ack` / concise `ack` accepts `choice`, one exact label; answering implies acknowledgement. The recorded answer appears in the sender’s inbox and the shared feed, linked by `messageId`. A different answer cannot replace the participant’s recorded choice; retry the same operation UUID after an unknown outcome. Ordinary free-text messages and acknowledgements remain available.
- **Limits** (new writes only): names 120 characters, summaries 2,000, message text 4,000, ids 200, up to 100 paths of 500 characters, page size 100, claim TTL 1 minute to 24 hours.
- **Retries.** Every write carries an operation UUID; concise actions generate one and return it. Retrying with the same UUID returns the original result. Cursors from `feed`, `inbox` and `related` are interchangeable and survive reconnects.

Announce your scope, claim the paths you will change, watch related activity, message when you need agreement and acknowledge what you read. Sessions carry a sequence number so an older report cannot replace a newer one. A completed session does not complete an Intent. Expired claims, old sessions and events are kept until the project is deleted.

## Scoped source grants

An importer can give an agent time-limited, read-only access to chosen files of one private import. In the repository page, open "Grant scoped agent reads", choose a snapshot, list exact paths, pick tools and set an expiry (one hour by default). Then run:

```sh
FORGE_AGENT_TOKEN=... nforge mcp-agent https://your-deployment.convex.cloud
```

The token goes in the environment only. The server advertises just the granted tools. A grant never grows. Issue another one for different access. The owner can inspect audit events and revoke at any time. See [security](security.md) for what this does and does not protect.

## Local compute for hosted checks

`nforge local-checks ROOT URL PROJECT_ID --name "My computer"` connects outward and waits. In the hosted Review page, pick a clean View, a check and your computer. The request carries only pins, never a command or source. Ctrl+C disconnects without cancelling a running check. Reconnect to reconcile its result.

## Index-only use

`nforge index ROOT` builds the code graph and `nforge doctor ROOT` checks the setup. The package also exports `indexRepository` and `openRepository` from `@nanthai/forge` for use as a library.
