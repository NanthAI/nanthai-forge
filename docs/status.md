# Status

What works today, what is partial, and what is missing. Update this page when a capability changes. What we are doing about the gaps is in the [roadmap](roadmap.md).

Lane saves use message titles, parent-relative file counts when source is available,
eight-character copyable hashes and row actions. Intent and Lane work maps show
current, superseded, accepted and failed-check candidates with marker tooltips.
Hosted remote checks explain output availability while continuing to read live logs.


The Now acceptance ledger
groups local and hosted acceptances by Intent with expandable details and deduplicates matching
receipts; mobile subnavigation uses the shared segmented control in both themes.

Lane and View changed-file panels offer an on-demand Map using the shared Code renderer. It shows touched files and static relative JS/TS neighbours, diffstat sizing, open-Lane markers and expandable folders above 50 touched files. Hosted Maps require the Map-capable source-review action.

Hosted native Lane/View summaries cache aggregate diffstats per immutable base/head pair during materialization. Oversized or binary comparisons keep file counts and unknown line totals.

Now and Work collapse large lists into Initiative or decision groups with counts and row continuation. Hosted presence continues beyond its initial page; Activity exposes earlier event pages. Cockpit saved filters, ownership areas, maintainer-specific queues and batch actions remain unavailable.

Verification bounds each test file to ten minutes by default (configurable), reports timed-out file names and terminates their process groups. Local presence contention no longer adds hosted-sync deferrals for unbound or opted-out owners.

## Works

Home combines projects and imported/shared source with filters; existing source bookmarks are stars. Settings has a grouped sidebar (mobile page selector), General default, policy-backed Autonomy, recorded Checks, owner contributor controls and supported personal preferences. Hosted-project stars are browser-local; imported-source stars use the account's saved locations. Hosted check definitions are edited locally and returned with Work.

| Area | What you can do |
| --- | --- |
| Native source | Create a project without Git; immutable content-addressed States; Lanes, checkpoints, line-level three-way merge, conflicts and resolution; Channels; recovery without Git; file and object-directory durability, staged Lane publication, and resumable atomic sync replacements. |
| Autonomy | Settings UI and per-project typed policy for local native/Git and hosted projects; supervised new projects; owner policy read/write through CLI/MCP/HTTP; agent acceptance enforced at Channel boundaries; protected paths and exact-View checks; review-ready finish; recorded native/Git auto-sync and retry-safe undo-sync. Existing projects read as custom with cleanup off. |
| Agent workflow | `start` / `finish` (checkpoint, policy-controlled update from `main`, compose, check, accept or await review) with optional pins; add sibling Lanes to an open Intent, finish several together, and record/resume stacked acceptance dependencies (`land-ready`); Intent/Lane/View track pins in status and hosted summaries; recorded Lane starters and acceptance actors; `sync`; review; logs; idempotent retries; per-Intent `making-of` record (CLI/MCP JSON: Lanes, saves, check queue/running time, landings, sessions, wall clock, estimated active time) and retry-safe `report` of self-declared harness, model and token totals; `tests` previews the landing check's scoped test selection and a runnable command for a saved Lane head; compact `status {laneId}`. |
| Agent briefings | Deterministic copy prompts and full briefings for nine situations (including add-lane and land-together); CLI, agent MCP and authorized hosted query; instruction-file paths and precedence; machine and observed MCP setup; retry-safe local/project/account guidance with owner-assigned guidance maintainers. No model inference or source contents in prompts. |
| Work contention | FIFO owner/Lane lock waits (ten-minute default, configurable), periodic stderr phase/run/queue/holder diagnostics and opt-in wait/hold timing; native agent start materialization, composition traversal and sync file writes outside the owner lock; per-Lane serialization and CAS publication preserve unrelated concurrent writes. Checks and rechecks hold no Work/Lane/Channel lock; finish metadata phases back off through revision races for the configured lock patience; pre-spawn contention retries with the original prepared run and capacity ticket, with cancellation rechecked before spawn. |
| Concurrent acceptance | Accepting never drops another accepted change. Local per-owner/Channel landing queues serialize final acceptance; `finish` retries Channel races with fresh sync/View/check and deterministic child IDs (three retries by default). Finish-driver and landing waits are bounded/configurable, and stderr reports lock/check/landing phases, run IDs, elapsed time and queue positions. Receipts include every attempt and queue positions; supervised/person acceptance requires review of a newly checked View when main moves. Line merges resolve pure insert/insert hunks at the same place by keeping both, main first (recorded as `both-insertions`). |
| Hosted landing gate | `acceptance.gate` is `full` (absent) or `contract`, set with the owner `set-policy` action. With `contract`, an owner agent's Candidate whose Intent declares a contract is accepted on a passing contract run (declared tests, changed tests, composed Intent union) on the exact Candidate; supervised acceptance, contributors, people, system changes, Intents without a contract, protected or unknown paths, and red or audit-debt main keep the full gate, and contract-only evidence never satisfies them. A full or docs pass satisfies either gate. Main may be briefly red; the asynchronous main audit and automatic recovery revert a single clean culprit or open a fix-forward Intent. The dogfood project runs `contract` since 2026-10-30 (revert with `gate: full`). |
| Checks | Browser Lane/Review byte-paged logs, failure jump, pinned line links, local same-View rerun/cancel receipts and hosted connected-runner requests limited to the caller’s own runners, with requester/runner-owner/project-owner cancellation and updates; retained object-checkpoint output with CLI fallback. Exact-View runs with recorded definition, environment and logs; clean HOME/XDG/temp directories, runtime allowlist, digest-bound per-check environment/credential passthrough and shared npm content cache for checks, Playbooks and automations; machine-wide check queue, queued cancellation, PID/start-identity dead-run recovery, and configurable disk warnings/refusal. One standard in-repo check (`scripts/forge-check.mjs`). Remote checks for a superseded Candidate are cancelled (recorded as cancelled-superseded with the newer Candidate); every cancellation records its actor and reason; quarantined tests are labelled in results. |
| View provenance | Local and hosted Intent work maps with time-ordered pinned saves and a bounded View window, numbered View pages with composition/record and expandable file/save/why/line attribution, and Lane participation links; local agent actions and authenticated HTTP reads for View detail, file/save provenance and Lane participation; authorized hosted indexed queries and native-object on-demand line attribution. Includes input save indexes, dependencies, supersession, acceptance actors/times, checks, changed-file counts and Forge-only rationale. Current-head passed Intent Views that are neither accepted nor superseded link to Review from the header and rows; large View file lists group loaded files by folder. Local Planning opens the retained editor. |
| Source context | Partial graphs for TypeScript, JavaScript, Python, Java and Rust; browser explorer; MCP tools. |
| Git compatibility | Git-backed projects; import/export between native and Git; GitHub publish, PR import, mirrors, Git clone/fetch of accepted source; native `github-sync` MVP adopts existing GitHub history and fast-forwards one commit per acceptance, with read-only dry runs and retry-safe State mappings and hosted publication status. |
| Hosted projects | `nforge host` seeds a hosted project once from a native or Git owner (retry-safe creation/upload/indexing, stderr/JSON progress); it no longer binds the folder for push/pull coordination. Public/private GitHub imports become agent-writable hosted projects with no Mac step (landed in `84741d8e`); an import of t3code (about 29,000 files) takes 16 min 56 s, against a goal of 5 minutes or less. Authorized browsing of source and Work; compact cockpit summaries with exact View inputs, run evidence and Lane save metadata, current-main ancestry for native and Git checkpoints (Lane heads already in main are done; View/run summaries separately report whether they include main) and authorized actor display names; `nforge exchange` pull, open and open-lane check out hosted main or a Lane; object-based browser backup imports and contributor proposals; owner planning. |
| CLI authentication | Device-code login with browser approval; Forge-issued scoped 30-day credentials, per-call revocation checks, account device list, logout/status and deployment-bound 0600 storage; environment override for CI. |
| Access | Repository readers, teams, hosted project reader grants (owner API; source/Work/activity reads only), contributors, pinned Zones, scoped agent read grants, Secret Objects with transitive delegation revocation and confirmation previews. |
| Coordination | Local and hosted sessions with distinct heartbeat receipt/activity time and kind, 15-minute working → quiet → folded after 90 minutes → left out of Who's working after 24 hours or once the Lane ends (dated last-seen), duplicate name+Lane collapse, validated parent/subagent nesting and harness attribution; 15-minute agent/subagent/person activity counts and 15-minute active/unannounced Lane counts, including an identity-free public-project aggregate; per-participant inbox and acks (including broadcasts), optional question choices with recorded answers; advisory path claims with overlap queries; handoffs; server `change` events on Work writes; feed scoped by Intent/Lane or related to your claims; input size limits (CLI and MCP). Advisory only. |
| Error capture | Hosted browser errors, render failures and failed Convex mutations/actions from signed-in accounts land in the `clientErrors` table with route path, user, project (when currently readable), build hash, function and error code; client dedupe/throttle and server-side scrubbing; owner-only per-project query. No UI, retention rule or account-inventory entry yet. |
| Operations | Backups, recovery, explicit dry-run/apply local cleanup, self-hosted backend, preview deployments; on-demand signed-in hosted UI screenshots at desktop/mobile widths and light/dark themes (see development). |

GitHub analysis owners can remove public or private analyses from Projects with shared-access confirmation. Removal hides source and lists immediately, invalidates workers, and drains dependent records and unshared storage in bounded batches.

## Partial

- **Hosted durability.** Snapshot export/comparison tooling compares whole-table record hashes, stored bytes, selected main and Lane/Candidate/Intent counts. A real drill on 2026-10-20 restored the development deployment into a fresh Convex deployment: export 146 s (787 MB, 27,143 stored files), import about 2 h 17 min (bound by stored files), verify 243 s with equal tables, files and Work. Code, authentication and environment were not redeployed on the scratch copy. A weekly backup runs on GitHub Actions (`hosted-backup.yml`, Mondays 03:00 UTC); the procedure keeps the newest four completed copies. See [procedure](operations/hosted-durability.md).

- **Check isolation boundary.** Synthetic local checks verify default SSH/AWS/Forge/GCloud/npm/dotenv discovery failures, omitted credential variables and exact-name HOME/file-path opt-ins. Clean environments are not OS isolation: known absolute files remain readable, and shared npm cache paths reveal the runner's home location. No claim of hostile-code confinement is made; see [security](security.md#clean-check-environments).

- **Provenance coverage.** Hosted file/save metadata is derived from retained native States; exact counts and line ranges use on-demand native object reads. Archive and Git hosted checkpoints retain local review. Binary/large files and expensive alignments report attribution unavailable; renamed paths do not imply lineage. Older saves have unknown actors.

- **Making-of coverage.** Local owners only: no hosted query or browser view yet. Sessions are the latest local presence observation per Lane actor, not a full session history. Tokens and models appear only when agents call `report`; the OpenTelemetry intake is designed but not built. Lane start time is known only for the Lane started with its Intent; runs recorded before queue timestamps show total duration only.
- **Hosted briefing source coverage.** Native object-checkpoint paths require derived preparation; archive/Git checkpoint paths come from local `brief`. Live messages/handoffs use an explicit hosted project binding. Older failed-run checkpoints may lack a retained summary.
- **Hosted ancestry coverage.** Native object/archive States and Git SHA-1/SHA-256 bundles index exact parent membership. Unavailable source or incomplete parent closure is unknown (`main.included: null`) without blocking retained Work reads. Old local actors and hosted machine observations remain unknown.
- **Hosted contention.** Unanchored notes, Intent creation/status and planning comments are revision-free server mutations; the separate Work head avoids invalidating unrelated project and collection queries. Anchored notes, planning replacements, Channel acceptance and source returns retain pinned checks; the legacy command action retains revision semantics. Internal Convex OCC retries remain possible.
- **Coordination.** Unannounced processes cannot be counted as agents; recent hosted saves/checks/claims expose unattributed Lane activity instead. Child harnesses must forward the environment returned by `forge_announce` to inherit parentage. Counts need a periodic refresh key as time passes. Agents share the human's account, so two agents of one user share one inbox (use session addressing to separate them). The browser shows last-seen and the new event kinds but has no claim, inbox or handoff controls yet.
- **Coordination paging.** Session roots and immediate children use separate bounded pages; flat pages let browser presence read every participant without recursive server expansion. Activity exposes older-event cursors. Imported Lane/run activity uses indexed timestamps; existing derived rows require the idempotent `coordinationBackfill:activity` migration after deployment.
- **UI.** The signed-out landing uses the Fable river-of-work canvas, animated Overlap mark and public GitHub import → graph/Now/briefing tour; motion pauses offscreen/hidden and reduced motion renders a still. One shell (Now · Work · Code · Settings) for local and hosted projects. Now shows open Lanes by attention, overlaps, decisions and recent changes (hosted: live sessions, claims, messages and handoffs). Work has Intents, Lanes and Planning; View details remain linked from their Intent and Lane, and the old Views list redirects to Intents; Activity lives under Now. The signed-in root is the project list; retired collection and classic Work URLs redirect into the shell. Project paths use readable name slugs with stable identity suffixes, with lossless short Work ids and rename redirects; Now Lane titles wrap with the Intent on its own line; other long Lane/Intent titles retain full-title tooltips. Decisions and accepted work appear once, with count pointers elsewhere. Now folds messages by Lane/Intent with bulk acknowledgement, sender metadata, first-sentence direct-message titles without repeated quote text, named links for loaded Work ids, compact current activity and matching session counts; queued checks stay static. Cancelled/interrupted checks stay static grey; historical failures superseded by a passed View are muted and linked. Now’s Activity sub-view filters and exports recorded events. The main strip and Home show the native main acceptance for native projects and the hosted selection for Git projects, with agent or person attribution. Broadcasts and messages from completed or abandoned sender work stay in Activity and scoped conversations, outside Needs you and its shared badges. People can acknowledge messages to any of their own account sessions, including legacy recipients; device agents retain exact-session acknowledgement, and Needs you includes only acknowledgeable messages. Settings transfer groups local handoff, checkpoint return and archive import; Code uses Files without the folder-card Graph mode. Home recent entries deduplicate by Intent. The shell and browser/app icons use the Forge Overlap mark; application loading uses a reduced-motion-aware orbit, with a fill variant available for development comparison. Journey rails explain their stops and state on hover/focus, and typed drafts use an in-app navigation confirmation. Lane pages share check evidence, remembered collapsible rails and file lists, Unified/Split/Inline word diffs, visible-line worker syntax highlighting, newest-first timelines and the delegate shortcut. Hosted Lane diffs fetch the selected file on demand. Local and hosted Review lead with Intent context, save cohorts, exact-View checks and acceptance decisions. Settings has Home-aligned navigation and role-aware controls. Diff views reuse visited pinned files and mount nearby rows for large hunks. Local Lane change summaries load progressively; hosted review byte caches retain current access and storage checks.

Hosted main is the only accept path for a project with server authority (the dogfood project since 2026-10-28). `nforge host --listen`, `--sync-agent`, `--auto-sync` and `--no-auto-sync` are refused with `CLI_UPGRADE_REQUIRED`, and no accept waits for a local owner receipt. `nforge serve ROOT` still starts a local Git/Work HTTP server; it and the native-owner code are deleted with B1.9. Revert creates an Intent and agent prompt for a checked compensating Lane, never a main rewind.

Project search (⌘K / Ctrl+K) reads Intents, Lanes, Views and available files through existing local and hosted APIs; empty search shows a short Needs-you/recent list and queries group up to five matches per type with Show all. Mobile has a search icon, full-screen palette and Now decision badge. Work headings share an inline collection switcher; incomplete filter counts and unavailable Planning counts are omitted. The top-bar Needs-you count shares Now’s decision source and session-local snoozes; Theme lives in the initials avatar menu as system/light/dark icons; the retired Appearance route redirects to General. Access shows names and handles, supports handle autocomplete and private pending email invitations redeemed at verified account setup. Contributions collapses to one sentence when empty. - **Autonomy UI and notifications.** Backend policy APIs and away-summary preference are available; dedicated policy controls and notification delivery are designed separately. Native object checkpoints support hosted protected-path checks; legacy archive/Git path coverage can require person review. Git updates preserve untracked/ignored obstructions rather than overwriting them.

## Missing or unproven

- **Agent value.** In the latest paired single-agent trials Forge used 14% more total input and 7% more time than plain Git. Landing throughput of already-finished multi-agent bursts was measured against GitHub's merge queue (4 agents 2.36×, 8 agents 3.20× as an early sample; [why Forge](why-forge.md#measured-landing-throughput)). Coordination quality and end-to-end multi-agent benefit are not yet measured ([evals](../evals/README.md)).
- **Import without a Mac.** It works, but a large repository is slow: 16 min 56 s for t3code against a goal of 5 minutes or less. Phase 5 stays open until that goal is met.
- **Forge against GitHub on a real repository.** The benchmark harness exists; no result is published. The numbers on [why Forge](why-forge.md) are historical (2026-10-20 to 2026-10-25).
- **R2 as the only byte path.** Required everywhere by owner decision (2026-10-31), not yet true: R2 placement is still opt-in, Convex file storage still holds data, and a few writers still use it (Issue 8678148e).
- Independent (non-owner) human acceptance testing; Edge and real coding-harness end-to-end runs.
- Managed execution, production deployment, public npm release, quotas, pricing, retention policy.
- Rename lineage across States; richer semantic relationships.

## Numbers worth knowing

- `scripts/perf-harness.mjs` records per-budget JSON for authenticated cold Now/Work, Lane first diff, bundle bytes and existing landing evidence (see [development](development.md#performance-budgets)). Live measurements require explicit `--live` and QA readiness marks; unrun results never pass. Full landing evidence distinguishes Intent lifetime from compose/check time and leaves unrecorded finish invocation duration unknown.
- Same-command hosted builds (`npm run build:hosted -- --manifest`) before/after route splitting: eager JavaScript 1,203,266 → 1,067,607 bytes (gzip 358,153 → 326,491); largest chunk 571,202 → 432,719 bytes; total JavaScript 1,649,242 → 1,660,218 bytes. These are build bytes, not measured page-load improvements. Manrope's Latin WOFF2 is 33,004 bytes versus the 164,700-byte TTF, with every original glyph retained across complementary subsets (73,708 bytes together). Retained monograms use lossless WebP; they are currently unused by the UI, so no browser transfer reduction is claimed. Live cold-load and Lane budget results for this slice remain unrun.
- Local contention fixture: a note invalidated 9/9 observed query read sets before and 4/9 after; paired writes returned `WORK_STALE` for 10/20 before and 0/20 after, with all notes retained. These are local dependency/serialized-transaction measurements, not live Convex subscription or OCC-retry measurements.
- About 680 test files. The landing check runs on free GitHub-hosted `ubuntu-latest` runners as a plan job plus test shards; a recent run took about 11 minutes wall (Issue 76ca1757). Shards are now balanced by recorded test durations (`7c3c9a70`); that change is not re-measured. Earlier Blacksmith, Modal and Mac timings were removed: Blacksmith use ended on 2026-10-25, Modal is not used, and the Mac check worker was stopped on 2026-10-29. There are no pushes to time: the push path was deleted.
- Changing a 16 MiB file uploads about 1.5 MB (content-defined chunks).
- Shared validation on a 31-root project dropped from 44 s to 0.4 s after the incremental validation work.
- Offline native hosting qualification (3,501 objects, 220 MB, 2,100 Work records, simulated 80 ms RTT): 211.9 s → 28.6 s (7.4×), usable at 12.6 s. Live-provider performance remains unverified.
- Estimated hosting cost: dogfooding $0–15/month; ~10 projects/30 agents $35–70; ~100 projects/300 agents $100–500 (Convex reads and file egress dominate). Estimates, not billed figures.

Canonical agent `abandon` closes Lanes or Intents with retained reason/actor/time, explicit save-first for dirty edits, optional Intent cascade and retry-safe operation ids. CLI, MCP and local HTTP share the behavior; exchange retains Work format 13 lifecycle history, hosted grey badges and closed filters. Reopen and capture-checked cleanup support abandoned Lanes.

CLI presence observers report coalesced file edits and queued/running checks without source reads or repository scans. Home discovers owner, contributor and reader projects with role labels.
Agent `link` (CLI/MCP) returns local cockpit and hosted save-pinned file URLs, including line selection. Saved-file readers use retained bytes without an index; checkpoint/finish receipts include Lane links.

Hosted native Review uses the same acceptance state in its header and decision
panel, with fully wrapping titles on mobile. Overlap recovery recomposes on the
owner's latest main and queues the normal check without accepting; conflict Views
remain explicit. Unchanged acceptance retries are offered for transient failures.

Work › Intents has a read-only Board alongside the List on local and hosted projects, using the same loaded records and derived statuses. Active Intents with no retained Lanes derive Planned without changing the Work format. Planned has a neutral list filter and a first Board column with five-card continuation; Planning and palette labels share the derivation. Planning filters and Initiative headers count their displayed Intent rows, with Intent/Status columns and export in the toolbar menu. Open counts exclude Planned; Now remains based on Lanes. Layout selection is URL-addressable and remembered per account and project in the browser. Work › Lanes uses the same row component as Intents, with Open · Ready · Done · All filters, find, a holder filter and a fact line saying who, what and when; an open Lane nobody holds reads Waiting · Nobody working. Lane, Intent and Initiative glyphs are shared across the Work switcher and rows.

Browser feedback retains failed drafts, reconciles hosted retries by payload, and connects Review
feedback and session actions to coordination. Unbound local owners use local notes and copied
prompts. Lane changes expose read failures and retry; local timelines read Lane-scoped history.

Source navigation: object/save/file Copy link pins saved source; file links retain
`#L` anchors. Ordinary file opens have no selected line; explicit line links highlight their target. Planning details close with ×, Escape or repeat selection and return focus to the row; phones use a full-screen sheet with Back. Work filters and diff selections survive history and reload. Lane
change summaries refresh against current main. Settings exposes transfer,
contributions, bound hosted administration and native GitHub sync commands/status.

The standard check supports conservative scope selection (available but OFF until
`FORGE_CHECK_SCOPED=1` is enabled after post-accept full main verification) from a runner-pinned
View comparison, packaged Markdown-only validation, streamed test progress and
recorded scope/reason/test lists. `FORGE_CHECK_FULL=1` forces the full suite. Old
runners without pinned comparison input continue to run full. Script changes follow
static imports, literal spawning paths and package-command consumers plus smoke;
standalone scripts add exact basename tests. Check-pipeline, packaging, build and
product-runtime script dependencies retain full coverage, as do uncertain scripts
or package commands. Selection evidence records the reason.

Native finish/accept supports an explicit disjoint fast-path autonomy option:
exact composed-main provenance, current passing evidence, manifest-path
disjointness and clean composition precede a CAS acceptance. Pending post-accept
full main checks coalesce, retain their runs and surface failures in Needs you.
A red main check creates one fix-forward Intent per failing head, with exact
run/landing links and a copyable agent prompt; accepted main is never rewound;
scoped standard-check acceptances use the same safety net. Checks stay outside
landing locks. Dependency/cohort acceptance completes exactly the pinned input
Lane heads. Failed-run summaries include their ellipsis within 4096 characters;
validated terminal receipts are durable before run workspace cleanup. Native check cleanup
with the lifecycle switch enabled records removals and skips separately after validating retained evidence under the owner lock. Policy-off terminal cleanup preserves legacy Work formats; run receipts remain unchanged. `DISK_LOW` refusals retain workspace and runtime files through later automatic sweeps.
The existing regenerable-copy lifecycle policy also removes reconstructable completed
or abandoned Lane folders on completion/abandonment and accepted-work completion;
reopen restores their retained head. Dirty, active, in-use and unverifiable copies stay.


The browser routes errors through a shared accessible toast stack in both shells, including forms, section reads and sign-in. Notifications deduplicate repeated messages, queue beyond three visible entries and preserve failed drafts. Acknowledge retries reuse the original operation id; connection loss produces one notification until recovery.

Hosted project URLs use unique account handles and owner-scoped project slugs. Settings can edit both; retained aliases and old ID-based links resolve through current access checks before client replacement. Existing hosted data requires the [readable URL backfill](readable-urls.md).

Detail pages have linked Work breadcrumbs and preserve browser Back across
in-page tabs. Action menus share dismissal and keyboard behavior; lifecycle
reasons use a small dialog. Lane source opens Code at its latest save with the
Lane shown in the Source picker.


Native finish supports interaction re-checks after an overlapping main movement.
With scoped mode enabled, clean Markdown overlap runs all merged static checks
without behavior suites or full main coverage after reused-run, composition,
ancestry, applicability and non-full side classification checks. Code interaction
requires full main coverage and runs impacted-test intersection plus overlap and
smoke. Valid ineligible evidence uses ordinary merged-View selection with its
reason; missing or malformed pins require full. Work format 15 retains versioned runner evidence
and command-reported exact test selection through portable export/import. Finish resolves
Markdown-only sync conflicts deterministically (both sides kept, main first;
edited prose and any code conflict still stop for the agent), records the paths
in the sync receipt and undo summary, and re-checks them with docs scope. The
exact-manifest zero-check landing rule and full post-accept main checks remain.
