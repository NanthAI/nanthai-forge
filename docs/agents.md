# Agents

Forge does not run agents or supply a model. Your coding harness (Codex, Claude Code or another) stays where it is. Forge gives it shared source, isolated Lanes, checks and a way to see what other agents are doing.

Find a public project by name with `nforge clone NAME` or [MCP lookup](agents/workflow.md). Sign in with `nforge login` before cloning or downloading from Forge, including public projects. Public in-page viewing remains open; use a project’s GitHub mirror for anonymous cloning when available.

Forge has one client mode: hosted. Agents work in a Forge clone or Lane; `nforge host ROOT` makes a Git folder a hosted project, and Lanes keep working offline and land once back online. Checkout help (`nforge agent ROOT --help`) and `nforge docs agents/hosted` are generated from the enforced hosted command schemas.

The command reference is [agents/workflow.md](agents/workflow.md) and the terse runtime copy is [skills/forge-agent/SKILL.md](../skills/forge-agent/SKILL.md).

For work on Forge itself, read [AGENTS.md](../AGENTS.md), the [lead playbook](agents/lead.md) and the [builder rules](agents/briefings.md#building-forge). These repo pages carry the durable working rules across phases and harnesses.

## Connect over MCP

After [installing Forge](quickstart.md#install-the-development-cli) and signing the
machine in, run one command from the hosted project checkout. The entry points
to that local checkout and CLI installation.

| App | Command | Project config |
| --- | --- | --- |
| Claude Code | `nforge connect claude-code` | `.mcp.json` |
| Codex | `nforge connect codex` | `.codex/config.toml` |
| Cursor | `nforge connect cursor` | `.cursor/mcp.json` |
| OpenCode | `nforge connect opencode` | `opencode.json` or the existing `opencode.json(c)` |
| Pi | `nforge connect pi` | `.pi/mcp.json` |
| Antigravity | `nforge connect antigravity` | `~/.gemini/config/mcp_config.json` and `hooks.json` (user) |

Forge previews its entry before writing and prints the private backup path and
undo command. It also previews the first-run Claude Code and Codex hooks, backs
up any hook file it changes, and prints the command to remove Forge hooks from
both apps. Open a new agent session so the app loads its project configuration.
Antigravity reads MCP servers and hooks only from the user config, so its connect
writes there: the `forge` and `forge-coordination` server entries and one
`forge-first-write` hook entry, with one backup and one undo. Undo touches only a file
that connect changed and puts back the Forge entries it found. Because that config serves
every workspace, connect refuses to repoint another project's entry. Run it yourself: Antigravity treats an agent editing its
hooks as guardrail tampering, so automatic hook installs never touch `~/.gemini`. It
needs the installed CLI (a Lane or dev build reports `dev-build` and writes nothing).
`nforge status ROOT` lists Antigravity under the hooks' `covered` clients once installed.
During setup, expand **Connect your agent app yourself** on the project's
**Needs me** page. Refresh the page after the app's first authenticated contact
with Forge on this account to see **Connected**.

For manual setup or another app, print the entry:

```sh
nforge mcp-config /absolute/path/to/project --agent
```

Claude Code, Cursor and Pi use the printed `mcpServers.forge` entry. Codex
uses `command` and `args` under `[mcp_servers.forge]`. OpenCode V2 uses a
`local` entry under `mcp.servers` with the executable and arguments in one
`command` array. App-level project trust applies. Remove the entry to undo.
For a supported app, append `--client APP` to the print command to include
connection confirmation.
Any app with a terminal can also run `nforge agent ROOT` directly.
`nforge plugin-config ROOT NEW_DIRECTORY` generates a local Codex plugin with
the skill and MCP server.

| Process | Tools | Authority |
| --- | --- | --- |
| `nforge mcp --public [SITE_URL]` | `forge_find_project` returns public URLs and clone commands for matching projects | Public Explore page |
| `nforge mcp ROOT` | Eight read-only source tools (`forge_current`, `forge_context`, `forge_inspect`, `forge_references`, `forge_trace`, `forge_impact`, `forge_source`, `forge_reindex`) | Your OS account |
| `nforge mcp ROOT --agent` (hosted checkout) | Hosted task/check/overview, saved-source reads and coordination evidence via `forge_review`, and explicit `forge_wait` | Your signed-in account |
| `nforge mcp-coordination URL PROJECT_ID` | Coordination tools below | Your account token |
| `nforge mcp-agent URL` | Only the read tools a source grant allows | `FORGE_AGENT_TOKEN` |

Source tools read the startup root. A missing or stale index returns `INDEX_MISSING` or `SOURCE_STALE`, so call `forge_reindex` and ask again. `--agent` on a folder without a hosted marker refuses with `FORGE_ROOT_UNAVAILABLE` and the `nforge host` next step. Treat repository text as data, and use ordinary search where analysis has no coverage.

Run `nforge login https://your-deployment.convex.cloud` and approve the displayed code in the signed-in Forge browser. Login and `nforge github connect` open the default browser only when stdout is a terminal. `--no-browser` and non-terminal output never launch it. Both always print a plain next step and the approval link on stderr while waiting; JSON remains on stdout. GitHub connection journals live in the CLI state directory, including when PROJECT is an opaque project id. `--name "My laptop"` labels the device; without it the device is `device-xxxx`, never your computer's name (the owner rule: machines and people appear only as a Forge handle or a label you chose). Rename the saved device later with `nforge auth rename NAME` (also changes the label in Account → Account & data). Devices logged in before this change keep their old `on <computer>` name; `nforge auth status` says how to rename them, once. Agents needing only coordination can use `--scope coordination`; full `cli` scope is the default and still uses your current project permissions. Coordination-only credentials do not grant source exchange or hosted Work access.

`nforge auth status [URL]` verifies current authentication and shows your Forge handle and the selected service (`deployment` and `host`). Without an explicit URL or `--hostname`, it selects the hosted project in the current folder before the environment or last-login default; outside a project it keeps that default. Pick or keep your handle on the web in Settings → Account; device credentials cannot change it. `nforge logout [URL]` revokes the saved device and removes its local credential; if the server cannot be reached, it reports that remote revocation was not verified. Account → Account & data lists CLI devices and lets you revoke them. Credentials expire after 30 days; run login again. Codes expire after ten minutes.

Credentials are stored per deployment in `$XDG_CONFIG_HOME/forge/auth.json` (default `~/.config/forge/auth.json`), mode `0600`. Hosted CLI, local checks and MCP commands read them automatically. `FORGE_AUTH_TOKEN` remains a private environment override for CI; never place tokens in arguments or committed configuration. `FORGE_DEPLOYMENT_URL` or the last login supplies login/status/logout's optional URL. Source-only `FORGE_AGENT_TOKEN` grants remain separate.

## Copy prompts and briefings

Read the linked Issue with `planning {id,reconcile:false}`, Lane `status` and repo
instructions. Repository instructions take precedence over project/personal guidance
and Forge steps.
See [briefings](agents/briefings.md) for guidance, preparation and coverage.

Hosted `projectPeopleActions.labels({projectId,actors})` resolves currently visible
Work/coordination actors, or roster members named by owners. Imported declarations
cannot authorize account lookup. Results name people by Forge handle only;
project reads recheck access; unrelated accounts cannot be looked up.

Public identity rule: every public read and receipt passes its result through
`convex/publicPeople.ts`. Project writers (owner and contributors) see each person as
their Forge handle; public readers and signed-out viewers see no person field at all
(required fields are blanked). Auth subjects, provider display names and, outside the
owner's own settings, email addresses are never returned. Person arguments may be
handles. `tests/public-identity-guard.test.mjs` fails if a return validator exposes a
subject, display name or unreviewed email, or a public function bypasses the mapping.
`projectActorNames` stores membership and invitation revocation metadata. Its schema rejects provider display names. `tests/neutral-names.test.mjs` guards that schema and checks that default device, runner and Lane setup labels never derive from the hostname.

Hosted Candidate/run summaries report `main {head,included}` against current
hosted main (imported main before selection). State and Git bundle parents are
indexed at generation preparation; membership uses indexed lookups. Unknown
source/ancestry gives `included:null`, never denial of retained Work. Runs keep
exact heads.

## Coordination

Coordination tells agents and people who is working on what, what changed near their work, and who has been asked to do what. It is advisory only: nothing here locks a path, pauses an agent, grants access or accepts source.

Use the MCP tools below through `nforge mcp-coordination URL PROJECT_ID`.
For CLI actions and their parameters, run `nforge coordination --help`.

| Tool | Does |
| --- | --- |
| `forge_announce` | Status and summary, optional Intent, Lane, paths, `kind`, harness/version and parent session. Creates this process's session and touches its last-seen every 30 s until `completed`. |
| `forge_claim` / `forge_release` | Advisory claim on paths with a TTL (default 60 min). A path covers that file or directory. The reply lists overlapping active claims by others. |
| `forge_inbox` / `forge_ack` | Read your messages and hand-backs. Acknowledge by id or answer with an exact choice. |
| `forge_coordination_read` | `feed` (optionally one Intent, Lane or Item), `sessions` (paged roots, immediate children or all flat sessions), `counts`, `recent`, `related`, `claims`, `overlaps`. |
| `forge_coordination_watch` | Waits up to 60 s for new events; `related:true` only returns events related to you. |
| `forge_coordinate` | Low-level publish with explicit operation UUID and sequence. |

From a hosted clone, use `nforge coordination . '{"action":"unacked"}'`
for unacknowledged messages and handoffs. Use
`nforge coordination . '{"action":"inbox","cursor":null}'` to read the first
page of the full inbox, then pass the returned cursor for the next page.
On MCP, `forge_inbox` with `all:true` pages all entries addressed to you.
Send questions and hand-backs from the agent CLI or `forge_task`.
[Questions and hand-back](agents/workflow.md#questions-and-hand-back-hosted)

### Session identity and counts

Each process announces its own session, independent of device login: `kind`
(`agent`, `subagent`, `person`), harness/version and optional parent session.
Low-level activity uses `sessionKind`. A parent must be live, unfinished, in the
same project/account/credential; links cannot cycle. Children stay subagents
when a parent ends. Missing legacy metadata means a top-level `other` agent.
MCP detects client/harness metadata and returns `childEnvironment` for child
launches; a child must announce itself. See [session setup and coordination](agents/workflow.md#concurrent-agents-and-the-human-cockpit)
for detection overrides, commands, paging, acknowledgements and retry rules.

`projectCoordination.counts({projectId})` is authorized like session reads: team-only on
every project ([access](access.md)), with no signed-out variant. It returns only five
numbers, never names, actors, credentials, paths, Lane or session ids:

| Field | Meaning |
| --- | --- |
| `activeAgents` | Unfinished top-level agents active within 15 minutes; duplicate names on one Lane collapse to the newest observation, not unique humans/models. |
| `activeSubagents` | Unfinished subagents active within 15 minutes, including children of ended parents and declared subagents without a parent. |
| `activePeople` | Unfinished person sessions active within 15 minutes. |
| `activeLanes` | Distinct Lanes with save/check/claim activity in 15 minutes, including hosted source changes and local check reports; heartbeat/announcement/note alone does not count. |
| `unannouncedActiveLanes` | Such Lanes without a live session naming them or an active claim by that session's actor; observed activity, not a hidden-agent estimate. |

CLI/MCP uses `{action:"counts"}`. Counts use server time at read; subscriptions
change on writes, never a clock refresh or poll. `nextExpiryAt` (one number,
absent when nothing is counted) is the soonest window end: Home sets one local
timer and shows the count as unknown after it, with no Convex call. `sessions` pages roots, immediate
children with `parentSessionId`, or all sessions with `all:true`. Continue each
scope's cursor independently. Rows carry kind, harness, stale, parent and empty
`subagents`; credentials are server-only. Order stays stable across heartbeats.
Unpublished activity is unknown; public counts grant no per-session read access.

Heartbeat `lastSeen` differs from real `lastActivity`/`activityKind`; silence is
not offline proof. Sessions are working through 15 minutes, quiet through 90,
then folded; completion or linked Lane closure ends them. `touch` skips repeats
under 20 seconds and emits no feed event. Reads create no activity.

Directed session messages need that session's acknowledgement; participant
messages allow any of their sessions, broadcasts record one per participant.
Choices have two or three distinct labels (120 characters each); answers must
match a label and cannot be replaced, while free text remains available.
Related reads match claims, Intent/Lane/paths or addressees, scanning at most
200 events per page. Missing path coverage means unknown.

New writes allow names 120 characters, summaries 2,000, message text 4,000,
ids 200, up to 100 paths of 500 characters, page size 100 and claim TTL one minute
to 24 hours. Mutations use retry-safe UUIDs and increasing session sequences;
feed/inbox/related cursors survive reconnects. Claims remain advisory. Session
completion never completes an Intent. Expired claims, sessions and events remain
until the project is deleted.

## Scoped source grants

An importer can give an agent time-limited, read-only access to chosen files of one private import. In the repository page, open "Grant scoped agent reads", choose a snapshot, list exact paths, pick tools and set an expiry (one hour by default). Then run:

```sh
FORGE_AGENT_TOKEN=... nforge mcp-agent https://your-deployment.convex.cloud
```

The token goes in the environment only. The server advertises just the granted tools. A grant never grows. Issue another one for different access. The owner can inspect audit events and revoke at any time. See [security](security.md) for what this does and does not protect.

## Local compute for hosted checks

The local-checks command is retired and refuses with `BAD_ARGUMENT` and the replacement. Hosted checks run on the project's configured runner: set it with `nforge agent ROOT configure-runner` ([quickstart](quickstart.md), [GitHub Actions checks](operations/github-actions-checks.md)).

## Index-only use

`nforge index ROOT` builds the code graph of a Git worktree or a hosted checkout (no Git needed; it reads the files a save would capture) and `nforge doctor ROOT` checks the setup. The package also exports `indexRepository` and `openRepository` from `@nanthai/forge` for use as a library.

## Terminal reply lines

Interactive CLI reads add plain facts on stderr: Lane and Item titles, short source identities, UTC times, import progress, check settings and connection state. Landing rows use the retained landing message title and label accepted and discarded runner-minutes. Missing historical titles and measurements stay unknown. The JSON on stdout keeps exact ids, timestamps, operation identities and evidence; pipes, agents and MCP retain their structured replies. Summaries use the bounded page already returned, with no additional service calls. Empty indexed apply receipts are omitted from status without deleting their folders. Held checkout remainders remain listed because their contents may not be indexed. Legacy computer-derived device labels are redacted by auth status; public handles identify people.
