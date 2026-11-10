# Status

Web typechecking uses the existing native TypeScript compiler in both npm and
the landing verifier. The JavaScript compiler remains an explicit all-scope
fallback; scratch-copy checks cover strict and JSX diagnostic parity.

Clone roots refresh from accepted main with `nforge pull ROOT`, agent `pull {}`
and the existing MCP `forge_task`. Root `status` reports freshness and accepted
source revision distance. Pull refuses local tracked edits, preserves disjoint
ignored outputs/dependency links, resumes interrupted publication, reuses cached
and unchanged local bytes, and fetches no source packs. Current pulls cost one
head query and no R2 GETs; receipts report requests and transferred bytes. Pull
preserves the root and surviving directory inodes for existing shells/editors and
applies through the Lane checkout's in-place delta journal, so its file work
scales with changed paths (unchanged files are trusted through the stat index).

The CLI lists open hosted Lanes in a single bounded page query (`agent ROOT lanes`),
records project friction without a Lane (`friction-list` pages it with its triage status; `x friction-triage` dismisses or links an Issue), diagnoses unaddressed roots and unavailable
cwd, queues local heavy commands first come, first served (waiters see their position and an estimate) and exposes holder and queue status by Lane without acquiring a slot.

What works today, what is partial, and what is missing. Update this page when a capability changes. What we are doing about the gaps is in the [roadmap](roadmap.md).

Lane saves use message titles, parent-relative file counts when source is available,
eight-character copyable hashes and row actions. Intent and Lane work maps show
current, superseded, accepted and failed-check candidates with marker tooltips.
Hosted remote checks explain output availability while continuing to read live logs.
CLI/MCP HTTP transports and complete Convex RPCs have deadlines; exhausted hosted
actions return IN PROGRESS with an exact original-operation continuation. Explicit
transfer deadlines retain their existing budgets.


The Now acceptance ledger
groups local and hosted acceptances by Intent with expandable details and deduplicates matching
receipts; mobile subnavigation uses the shared segmented control in both themes.

Lane and View changed-file panels offer an on-demand Map using the shared Code renderer. It shows touched files and static relative JS/TS neighbours, diffstat sizing, open-Lane markers and expandable folders above 50 touched files. Hosted Maps require the Map-capable source-review action.

Hosted native Lane/View summaries cache aggregate diffstats per immutable base/head pair during materialization. Oversized or binary comparisons keep file counts and unknown line totals.

Now and Work collapse large lists into Initiative or decision groups with counts and row continuation. Hosted presence continues beyond its initial page; Activity exposes earlier event pages. Cockpit saved filters, ownership areas, maintainer-specific queues and batch actions remain unavailable.

Verification bounds each test file to ten minutes by default (configurable), reports timed-out file names and terminates their process groups. Local presence contention no longer adds hosted-sync deferrals for unbound or opted-out owners.

Hosted save, sync and resolve receipts split `hostedWait` into server phases under `timing.server` (`--detail`): dispatch delay, each source step's scheduling wait, run, R2 read/write and Convex call time and counts, the phases it ran, why it stopped and the kinds of objects it read, publication and the client's remaining watch. Small save and sync results publish from the step's own commit without the finalizing action, and the Node source worker no longer loads the CLI's modules at cold start. A small save makes one object commit round and no separate `stage` call, and its source step reads baseline, page and input in parallel (Issue 1eef1b43). A save, sync or compose commits, submits and runs its first step in one call with no scheduler wait, and a resolve's sync starts on the server when its save completes, so the CLI makes no second round of calls.

Source capture works the same in any language: a tracked file is saved and mirrored to GitHub whatever its name (test certificates, `.envrc`, `.npmrc`, `.env.development`); only VCS/Forge metadata and `private-artifacts` stay out of publication. A new file with a credential-looking name is saved unless the landing secret scan's patterns find a credential in it or it is a local credential file; build folders follow `.gitignore`/`.forgeignore`, and `credentials.*`/`secrets.*` code modules are saved in any common language. A save receipt's `notSaved` names up to 20 new paths a built-in rule left out, with a one-line way to include one ([source exclusions](operations.md#source-exclusions)). Synthetic Go, C#, Kotlin and Forge-layout fixtures cover it.

Hosted sync/resolve local apply preserves ignored build output and dependency
links using project ignore rules and Forge source exclusions. Saved source and
incoming path collisions remain protected; interrupted artifact moves resume with
the original apply operation. Relative checkout roots use a canonical sibling
client cache. A sync/resolve apply onto an installed checkout installs only the
changed paths in place, under a crash-safe journal (a one-file apply on a
synthetic 29,000-file checkout: 9 hashes and 1 clone instead of 116,004 and
29,000). Save, abandon, preflight and every other command that trusts the
checkout marker finish or roll back an interrupted apply first, so a crash
mid-apply never turns upstream bytes into local edits. The clean check still
stats every materialized path, like Git.

Hosted source-worker diagnostics retain typed dependency/runtime failures, the
failing source step and call, and digest/size context when known. The landing
check verifies that deployed function dependencies resolve from isolated bundles;
source import reconciliation includes its parser in the bundle.

Durable source and mirror reads verify legacy file IDs against live project
ownership before fetching bytes. Unowned references return `SOURCE_REF_UNOWNED`;
unregistered old continuations need migration. R2 reads add no ownership RPC.

Per-landing [speed and cost budgets](agents/speed-budgets.md) cover submit-to-main, checks, settlement, save/preflight, attempts, Work writes, R2 compose I/O and runner minutes; rolling-window breaks and recoveries share the existing alert and Issue path. [Flip 5's Work store](architecture.md) supports item versions and independent primary writers, with explicit reader/writer cutover and comparison rather than a claim that every deployment has switched.

The [batched CI result inbox](operations/github-actions-checks.md#batched-result-inbox) folds shard results by metadata page and keeps per-file reports off run heads; independent provider conclusions authorize exact-verdict reuse. A landing records its [first-check proof](pre-queue-checks.md#decision) or the reason it rechecks; the exit bench uses its [own manually pinned deployment](workflows.md#automatic-main-mirror), while pushed mirror commits touching deploy paths deploy dev automatically.

## Works

Managed CLI work checks accepted Forge main once per process. When main moved,
commands keep running on the working build while one detached updater stages,
canary-tests and atomically selects the new one; after a failed install, writes
install in the foreground or refuse with a typed recovery command. First-write hooks follow current and survive old-build pruning;
in-flight runtime leases protect lazy imports. Releases are signed (Ed25519, release-numbered)
by the owner or the automated `release-sign` GitHub job, and required: an unsigned main holds on
the current build until its signature appears. `nforge cli release-verify` re-checks stored
signatures.
See [CLI updates](operations/cli-update.md).
Live release adoption and billed-usage qualification remain unverified.

- Hosted CLI diff pins Lane base/saved-head source with byte-budgeted pages.
  Peers reads the existing saved overlap projection, including a single path
  before its first save. Exact State/Candidate show and the existing MCP
  `forge_review` expose these reads with current access and explicit omissions.

Hosted land/save reject complete conflict hunks locally before compose/check; resolve accepts Lane subdirectories. Receipts retain one recovery step. A sync conflict from the builder's own Lane folder resolves in that folder (unsaved edits kept, overlapping ones copied aside) and prints one `WORK IN` line; other resolutions open as a whole-tree sibling, never nested; landing the resolution completes the original Lane, and replays of the original landing follow the resolution's actual state.

Hosted compose parses every text-merged JS/TS, Python, Java, Rust and JSON file and reports a file that no longer parses (while each side does) as a composition conflict with the parser message, before any check runs; sync and local composition do not.

- Hosted relative, trailing-slash and symlinked roots keep source-read caches beside
  the canonical checkout. Sync/resolve preserve verified legacy misplaced caches;
  blocked local applies expose executable preservation recovery through CLI/MCP.

Home combines projects and imported/shared source with filters; existing source bookmarks are stars. Settings has a grouped sidebar (mobile page selector), General default, policy-backed Autonomy, recorded Checks, owner contributor controls and supported personal preferences. Hosted-project stars are browser-local; imported-source stars use the account's saved locations. Hosted check definitions are edited locally and returned with Work.

| Area | What you can do |
| --- | --- |
| Native source | Create a project without Git; immutable content-addressed States; Lanes, checkpoints, line-level three-way merge, conflicts and resolution; Channels; recovery without Git; file and object-directory durability, staged Lane publication, and resumable atomic sync replacements. |
| Autonomy | Settings UI and per-project typed policy for local native/Git and hosted projects; supervised new projects; owner policy read/write through CLI/MCP/HTTP (`nforge policy ROOT` and `nforge set-policy ROOT JSON` also work on hosted projects); trust per path per actor is a policy field `trust`, absent = off, `trust:{enabled:false}` records history without changing any gate; agent acceptance enforced at Channel boundaries; protected paths and exact-View checks; review-ready finish; recorded native/Git auto-sync and retry-safe undo-sync. Existing projects read as custom with cleanup off. |
| Agent workflow | `start`, `save` and `land` (`land --save` is the old `finish`: checkpoint, policy-controlled update from `main`, compose, check, accept or await review) with optional pins; operator and repair actions run as `nforge x ROOT ACTION`; `start {planningItemId}` links an Issue, which closes when its Intent completes; on hosted projects `pin` (owner) keeps a Lane out of cleanup (complete-merged, completeOnAccept, Intent cascade, prune, cache GC) until unpinned, `preflight` runs the project's triggered static checks (`preflight.static` in a root `forge.json`, any language, or `forge.preflight.static` in package.json) first, then, with the project's declared or inferred test runner (`preflight.tests` in a root `forge.json` or `forge.preflight.tests` in package.json; else inferred from the `test` script through named scripts, every runner of a chained script kept, then the manifest package graph's per-ecosystem commands for Go, Rust, Python, Gradle and Maven builds in any folder, .NET, and JS workspaces or standalone packages; none: `tests unavailable`; any JS/TS repository gets a static import graph, `run {tests}` takes that runner's files), nearby consumers and tests that watch names the change creates locally, defers broader coverage to landing and reuses unchanged per-file passes after delta edits and `land --save` refuses without a pass by default when the project declared its runner (inferred package commands only advise, priced from this machine's or the hosted check's timings); a source-bound `ENVIRONMENT / FILESYSTEM_EVENTS_UNHEALTHY` or `TOOLCHAIN_MISSING` (program not installed) receipt advises continuation to the hosted check, `nforge doctor` reports finite target-volume event health with fseventsd metrics and recovery, and `ack` answers overlap notices; add sibling Lanes to an open Intent, finish several together, and record/resume stacked acceptance dependencies (`land-ready`); a hosted stacked Lane's `save` restacks it onto its parent's newer saved work when that applies cleanly (a conflict changes nothing and names `sync`); Intent/Lane/View track pins in status and hosted summaries; recorded Lane starters and acceptance actors, with the agent run (session slug) on hosted receipts (`agentRun`) and idle-Lane and presence hints scoped to the run, so agents on one account tell each other apart; `sync`; review; logs; idempotent retries; per-Intent `making-of` record (CLI/MCP JSON: Lanes, saves, check queue/running time, landings, sessions, wall clock, estimated active time) and retry-safe `report` of self-declared harness, model and token totals; `tests` previews the landing check's scoped test selection and a runnable command for a saved Lane head (the project's test runner and test paths; none: scope `unavailable`); compact `status {laneId}`. |
| Agent briefings | Deterministic copy prompts and full briefings for nine situations (including add-lane and land-together); CLI, agent MCP and authorized hosted query; instruction-file paths and precedence; machine and observed MCP setup; retry-safe local/project/account guidance with owner-assigned guidance maintainers. No model inference or source contents in prompts. |
| Planning | Hosted CLI/MCP ranked title/body search with status, kind and Initiative filters, bounded cursors and explicit legacy preparation coverage. New Issues/friction return advisory duplicate candidates. Summaries include Initiative membership, body length and Done-when presence. Live deployment and billed search usage require operator verification. |
| Dormant Lanes | An open hosted Lane with no record write for `agentDefaults.dormantAfterDays` (default 2, `0` off) is dormant: left out of overlap notices, presence, board signals and the Lanes listed at start, through an index on the Lane's last activity (no scan, idle zero); any save or start revives it. `lanes {view}` lists live or dormant Lanes, and `x abandon-dormant` dry-runs or abandons (25 per call) dormant Lanes whose saved head landed (stamped, named in a receipt, or every changed path equals main's bytes) or was never saved. Abandoning from a clean checkout older than its Lane pins the Lane as the server has it (no WORK_STALE). A landing completes its accepted Lanes even after a bare record version bump. |
| Work contention | FIFO owner/Lane lock waits (ten-minute default, configurable), periodic stderr phase/run/queue/holder diagnostics and opt-in wait/hold timing; native agent start materialization, composition traversal and sync file writes outside the owner lock; per-Lane serialization and CAS publication preserve unrelated concurrent writes. Checks and rechecks hold no Work/Lane/Channel lock; finish metadata phases back off through revision races for the configured lock patience; pre-spawn contention retries with the original prepared run and capacity ticket, with cancellation rechecked before spawn. |
| Concurrent acceptance | Accepting never drops another accepted change. Local per-owner/Channel landing queues serialize final acceptance; `finish` retries Channel races with fresh sync/View/check and deterministic child IDs (three retries by default). Finish-driver and landing waits are bounded/configurable, and stderr reports lock/check/landing phases, run IDs, elapsed time and queue positions. Receipts include every attempt and queue positions; supervised/person acceptance requires review of a newly checked View when main moves. Line merges resolve pure insert/insert hunks at the same place by keeping both, main first (recorded as `both-insertions`). An agent ends its own known failing hosted landing with `land --withdraw` (one call, Lane author or owner): the Lane, saves and check evidence stay, stacked peers recompose without it, and the builder re-lands the same Lane. |
| Hosted landing gate | `acceptance.gate` is `full` (absent) or `contract`, set with the owner `set-policy` action; the supervised preset sets `full`, the trusted and autonomous presets set `contract`, and a project without a preset reads as `full`. With `contract`, an eligible agent's Candidate (the owner's agent by default; with `acceptance.autoActors` set, exactly the listed agents; with `trust.enabled`, another agent once trust lifts it above supervised on the Candidate's paths) whose Intent declares a contract is accepted on a passing contract run (declared tests, changed tests, composed Intent union) on the exact Candidate; supervised acceptance, unlisted or untrusted contributors, people, system changes, Intents without a contract, protected or unknown paths, and red or audit-debt main keep the full gate, and contract-only evidence never satisfies them. A full or docs pass satisfies either gate. An admitted change whose composition on a moved main is clean and path-disjoint from what main gained, with no global-risk file, lands on its first (admission) check, whatever check command the project configures; the receipt's `firstCheck` records that path or the recheck reason ([pre-queue checks](pre-queue-checks.md#decision)), and `metrics` counts every fast-path fallback reason per stage, flagging Forge limitations ([fallback reasons](operations.md#fallback-reasons)). A check definition may opt in to `docsPaths` ([docs-only paths](pre-queue-checks.md#docs-only-paths)): a docs-only change then runs no command and a clean Markdown overlap outside tests lands on its first check; the default runs everything. Main may be briefly red; the asynchronous main audit (armed at once after a first-check landing) and automatic recovery revert a single proven culprit through an ordinary landing or open a fix-forward Intent, never rewinding main. The dogfood project runs `contract` since 2026-10-30 (revert with `gate: full`). A hosted entry with no progress for 15 minutes raises `LANDING_STALLED`; a queued one that Forge cannot re-drive and nothing live is driving is ended after 60 minutes as `terminal-failed` with a stated reason (nothing landed; land the same Lane again). Stall alerts by email or webhook are on by default (`stallAlerts`) and need recipients or a webhook configured. The same channels send one alert when a per-landing speed or cost budget breaks over its rolling window, and one recovery when it returns within budget ([speed budgets](agents/speed-budgets.md)). |
| Checks | Browser Lane/Review byte-paged logs, failure jump, pinned line links, local same-View rerun/cancel receipts and hosted connected-runner requests limited to the caller’s own runners, with requester/runner-owner/project-owner cancellation and updates; retained object-checkpoint output with CLI fallback. Exact-View runs with recorded definition, environment and logs; clean HOME/XDG/temp directories, runtime allowlist, digest-bound per-check environment/credential passthrough, shared npm, Go, Cargo, Gradle, Maven, pip, uv and NuGet content caches and default-location rustup/pyenv/mise/asdf toolchain homes for checks, Playbooks and automations; machine-wide check queue, queued cancellation, PID/start-identity dead-run recovery, and configurable disk warnings/refusal. One standard in-repo check (`scripts/forge-check.mjs`). Hosted landing checks scan the Candidate's changed paths for credentials first and fail on a finding, naming file and line, never the value; a false positive is overridden by an entry in `.forge-secret-allow.json` that counts only once it is on main, and project owners are alerted for each added entry ([security](security.md#secret-scan-at-landing)). Remote checks for a superseded Candidate are cancelled (recorded as cancelled-superseded with the newer Candidate); every cancellation records its actor and reason; quarantined tests are labelled in results. A private project runs Actions checks only in a private runner repository, enforced at connect, dispatch and each runner call, unless its owner accepts public check logs on that runner with `publicLogs:true`, which receipts then state (`RUNNER_REPOSITORY_PUBLIC`; [security](security.md#hosted-check-authorization)). Hosted checks (Actions and self-hosted) materialize submodules at their pinned commits from credential-free HTTPS URLs and refuse other URLs with `SUBMODULE_NOT_MATERIALIZED` ([submodules in checks](operations/github-actions-checks.md#submodules-in-checks)); clones, pulls and Lane checkouts check them out too, as opaque entries whose HEAD is the pointer ([submodules](workflows.md)). |
| View provenance | Local and hosted Intent work maps with time-ordered pinned saves and a bounded View window, numbered View pages with composition/record and expandable file/save/why/line attribution, and Lane participation links; local agent actions and authenticated HTTP reads for View detail, file/save provenance and Lane participation; authorized hosted indexed queries and native-object on-demand line attribution. Includes input save indexes, dependencies, supersession, acceptance actors/times, checks, changed-file counts and Forge-only rationale. Current-head passed Intent Views that are neither accepted nor superseded link to Review from the header and rows; large View file lists group loaded files by folder. Local Planning opens the retained editor. |
| Source context | Partial graphs for TypeScript, JavaScript, Python, Java, Rust, Go and C# (C#: declarations and `using` edges); a file-level entry for every other text file; browser explorer; MCP tools. |
| Git compatibility | Git-backed projects; import/export between native and Git; GitHub publish, PR import, mirrors, Git clone/fetch of accepted source; hosted GitHub imports keep the repository's Git history (GitHub's own pack bytes in R2, same commit ids) with Lane `history` log, blame and file-at-commit reads that match GitHub ([history](agents/workflow.md#hosted-reads-and-coordination-limits)); plain `git clone` of that history from Forge waits on hosted Git serving (Issue 09367fb2); native `github-sync` MVP adopts existing GitHub history and fast-forwards one commit per acceptance, with read-only dry runs and retry-safe State mappings and hosted publication status. Mirrors retain supplied landing subjects, bodies and ordered trailers across cohorts and retries, with unchanged sync identities and published history. |
| Hosted projects | `nforge host` seeds a hosted project once from a native or Git owner (retry-safe creation/upload/indexing, stderr/JSON progress); it no longer binds the folder for push/pull coordination. Public/private GitHub imports become agent-writable hosted projects with no Mac step (landed in `84741d8e`); an import of t3code (about 29,000 files) takes 2 min 31 s and 2 min 37 s in two runs, until the project is agent-writable (goal: 5 minutes or less). A GitHub import never needs a Mac owner: the published project is born hosted, and an archive import lists its objects in a sorted catalog (256 pins per row) rather than one row per object. A checkout still missing 500 or more objects after the machine cache reads the project's source pack (one gzip R2 object of main, up to 300 MB and 100,000 files, otherwise ordinary transfer; `nforge x ROOT source-pack` packs current main) instead of one request per object, and the machine keeps a shared object cache. Authorized browsing of source and Work; compact cockpit summaries with exact View inputs, run evidence and Lane save metadata, current-main ancestry for native and Git checkpoints (Lane heads already in main are done; View/run summaries separately report whether they include main) and authorized actor display names; `nforge exchange` pull, open and open-lane check out hosted main or a Lane; object-based browser backup imports and contributor proposals; owner planning. |
| CLI authentication | Device-code login with browser approval; Forge-issued scoped 30-day credentials, per-call revocation checks, account device list, logout/status and deployment-bound 0600 storage; environment override for CI. |
| Access | Repository readers, teams, hosted project reader grants (owner API; source/Work/activity reads only), contributors, pinned Zones, scoped agent read grants, Secret Objects with transitive delegation revocation and confirmation previews. |
| Coordination | Local and hosted sessions with distinct heartbeat receipt/activity time and kind, 15-minute working → quiet → folded after 90 minutes → left out of Who's working after 24 hours or once the Lane ends (dated last-seen), duplicate name+Lane collapse, validated parent/subagent nesting and harness attribution; 15-minute agent/subagent/person activity counts and 15-minute active/unannounced Lane counts, including an identity-free public-project aggregate; per-participant inbox and acks (including broadcasts), optional question choices with recorded answers; advisory path claims with overlap queries; handoffs; server `change` events on Work writes; feed scoped by Intent/Lane or related to your claims; input size limits (CLI and MCP). Advisory only. Hosted agent board: short notes (240 characters) to a Lane, an Issue or the project for members with write access, delivered on the next Lane action with local read state; 14-day retention, rate limits, per-account caps and operator stop switches ([agent board](agents/workflow.md#agent-board-hosted)). Live deploy and billed usage need operator verification. |
| Error capture | Hosted browser errors, render failures and failed Convex mutations/actions from signed-in accounts land in the `clientErrors` table with route path, user, project (when currently readable), build hash, function and error code; client dedupe/throttle and server-side scrubbing; owner-only per-project query. No UI, retention rule or account-inventory entry yet. |
| Operations | Backups, recovery, explicit dry-run/apply local cleanup, self-hosted backend, preview deployments; on-demand signed-in hosted UI screenshots at desktop/mobile widths and light/dark themes (see development). Bytes go to R2 only ([data placement](data-placement.md)); `bytes by location` in self-metrics must read 0 for Convex. Open tabs cost nothing while idle: live queries re-run on server writes only, and `npm run check` fails a query argument that follows the clock (`scripts/check-idle-queries.mjs`). The client keeps its machine files bounded without a daemon: a shared object cache, one `forge-tmp` temp root (entries older than two hours and not in use are swept at CLI start, at most hourly) and `.metadata_never_index` markers so Spotlight skips Forge temp and cache roots. A release prunes old runtime releases (keeps three, never one in use) and removes the `.env*` files its build copied in. |

GitHub analysis owners can remove public or private analyses from Projects with shared-access confirmation. Removal hides source and lists immediately, invalidates workers, and drains dependent records and unshared storage in bounded batches.

- Pending finish/land receipts provide one blocking wait on the original operation;
  CLI exits with unfinished work warn agents to continue. Killed waits resume from
  that command; native waits use `until:"terminal"`, hosted landings `until:"acceptance"`.
  Retryable source work returns its exact recovery without an idle observer;
  a failed child keeps waiting for the canonical parent outcome.
  Forge has no external agent-turn-end hook; arbitrary harness runs without a
  Forge run identity remain outside this wait contract.

## Partial

- **Hosted queue model.** An opt-in [TLA+ model](../models/landing-queue/README.md) checks bounded queue safety/liveness and incident shapes. It records fairness assumptions and implementation gaps, including cross-head reuse versus exact-check equality. A source phase-name guard runs with foundation checks. This is not a proof of the implementation or live provider recovery. Same-group prefix conflicts stay advisory until the included group settles, then retry on accepted main without agent action. Conflicts independently proven against main still report promptly; both source workers and deterministic cohort regressions guard the distinction.

- **Hosted durability.** Snapshot export/comparison tooling compares whole-table record hashes, stored bytes, selected main and Lane/Candidate/Intent counts. A real drill on 2026-10-20 restored the development deployment into a fresh Convex deployment: export 146 s (787 MB, 27,143 stored files), import about 2 h 17 min (bound by stored files), verify 243 s with equal tables, files and Work. Code, authentication and environment were not redeployed on the scratch copy. A weekly backup runs on GitHub Actions (`hosted-backup.yml`, Mondays 03:00 UTC); the procedure keeps the newest four completed copies. Deployment snapshot validation retries transient unavailable Work indexes at most twice (15s/45s); errors name the sub-step and next action. Failed backup jobs use the existing ntfy/Cloudflare stall-alert transport when configured in the Actions environment; real owner delivery still needs configuration and qualification. See [procedure](operations/hosted-durability.md).

- **Check isolation boundary.** Synthetic local checks verify default SSH/AWS/Forge/GCloud/npm/dotenv discovery failures, omitted credential variables and exact-name HOME/file-path opt-ins. Clean environments are not OS isolation: known absolute files remain readable, and shared npm cache paths reveal the runner's home location. No claim of hostile-code confinement is made; see [security](security.md#clean-check-environments).

- **Check reports from any command.** Any hosted check command can write JUnit XML to `FORGE_JUNIT_DIR`; Forge reads failing files, first errors, timings and tool-reported flakes from it, names likely batch culprits by test file name in any folder or JVM stack-frame class, counts a JUnit-covered contract union test as run, and re-runs learned failures of any test layout ([JUnit reports](operations/github-actions-checks.md#junit-xml-reports-from-any-check)). Synthetic vitest, pytest, Surefire and Go reports are covered; no live non-Forge hosted run has used it yet.

- **Provenance coverage.** Hosted file/save metadata is derived from retained native States; exact counts and line ranges use on-demand native object reads. Archive and Git hosted checkpoints retain local review. Binary/large files and expensive alignments report attribution unavailable; renamed paths do not imply lineage. Older saves have unknown actors.

- **Making-of coverage.** Local owners only: no hosted query or browser view yet. Sessions are the latest local presence observation per Lane actor, not a full session history. Tokens and models appear only when agents call `report`; the OpenTelemetry intake is designed but not built. Lane start time is known only for the Lane started with its Intent; runs recorded before queue timestamps show total duration only.
- **Finish observation correctness.** Hosted terminal waits retain the current canonical attempt and its terminal version, including when old input pages settle across attempt replacement. Ready and settled inputs alone cannot end the wait. Deterministic client fixtures cover replacement before, during and after Ready, same-attempt settlement, cursor replay and zero idle calls.
- **Finish observation cost.** Finite hosted finish pages use transactional selected-field projections and reuse the selected request row. Synthetic call/read budgets and dependency tests cover unrelated publications, progress, conflicts and acceptance; history pages remain bounded. Old untouched rows retain selected source-row fallback. Deployment, live per-function savings, idle and wall-time qualification remain separate from these tests.
- **Hosted agent reads.** nforge 0.3.1 has no hosted `peers`, `diff`, `brief`, `link` or native review/handoff actions. Use start/save/status overlap advice (bounded saved paths, excluding unsaved peer edits), `show` for exact saved bytes, planning comments for delivery evidence and `observe {runId}` plus its provider link for logs. See [hosted read limits](agents/workflow.md#hosted-reads-and-coordination-limits).
- **Hosted briefing source coverage.** Native object-checkpoint paths require derived preparation; archive/Git checkpoint paths come from local `brief`. Live messages/handoffs use an explicit hosted project binding. Older failed-run checkpoints may lack a retained summary.
- **Hosted State generations.** Fixed-worker State creation and bootstrap/Git/GitHub snapshot import persist authenticated topological levels on existing object metadata. Selections with one shared maximal pairwise base use generation ordering to avoid closed-side and wide historical walks; old metadata, multiple bases and additional restore roots retain BFS. A finite dev operator pass with metadata-only preview is available; deployed backfill and billed usage remain operator qualification.
- **Hosted ancestry coverage.** Native object/archive States and Git SHA-1/SHA-256 bundles index exact parent membership. Unavailable source or incomplete parent closure is unknown (`main.included: null`) without blocking retained Work reads. Old local actors and hosted machine observations remain unknown.
- **Hosted contention.** Unanchored notes, Intent creation/status and planning comments are revision-free server mutations; the separate Work head avoids invalidating unrelated project and collection queries. Anchored notes, planning replacements, Channel acceptance and source returns retain pinned checks; the legacy command action retains revision semantics. Internal Convex OCC retries remain possible.
- **Coordination.** Unannounced processes cannot be counted as agents; recent hosted saves/checks/claims expose unattributed Lane activity instead. Child harnesses must forward the environment returned by `forge_announce` to inherit parentage. Counts re-run on server writes only (no clock-driven query argument, so idle tabs cost nothing), so they can show an agent past its 15-minute window until the next write. Agents share the human's account, so two agents of one user share one inbox (use session addressing to separate them). The browser shows last-seen and the new event kinds but has no claim, inbox or handoff controls yet.
- **Coordination paging.** Session roots and immediate children use separate bounded pages; flat pages let browser presence read every participant without recursive server expansion. Activity exposes older-event cursors. Imported Lane/run activity uses indexed timestamps; existing derived rows require the idempotent `coordinationBackfill:activity` migration after deployment.
- **UI.** The signed-out landing uses the Fable river-of-work canvas, animated Overlap mark and public GitHub import → graph/Now/briefing tour; motion pauses offscreen/hidden and reduced motion renders a still. One shell (Now · Work · Code · Settings) for local and hosted projects. Now shows open Lanes by attention, overlaps, decisions and recent changes (hosted: live sessions, claims, messages and handoffs). Work has Intents, Lanes and Planning; View details remain linked from their Intent and Lane, and the old Views list redirects to Intents; Activity lives under Now. The signed-in root is the project list; retired collection and classic Work URLs redirect into the shell. Project paths use readable name slugs with stable identity suffixes, with lossless short Work ids and rename redirects; Now Lane titles wrap with the Intent on its own line; other long Lane/Intent titles retain full-title tooltips. Decisions and accepted work appear once, with count pointers elsewhere. Now folds messages by Lane/Intent with bulk acknowledgement, sender metadata, first-sentence direct-message titles without repeated quote text, named links for loaded Work ids, compact current activity and matching session counts; queued checks stay static. Cancelled/interrupted checks stay static grey; historical failures superseded by a passed View are muted and linked. Now’s Activity sub-view filters and exports recorded events. The main strip and Home show the native main acceptance for native projects and the hosted selection for Git projects, with agent or person attribution. Broadcasts and messages from completed or abandoned sender work stay in Activity and scoped conversations, outside Needs you and its shared badges. People can acknowledge messages to any of their own account sessions, including legacy recipients; device agents retain exact-session acknowledgement, and Needs you includes only acknowledgeable messages. Settings transfer groups local handoff, checkpoint return and archive import; Code uses Files without the folder-card Graph mode. Home recent entries deduplicate by Intent. The shell and browser/app icons use the Forge Overlap mark; application loading uses a reduced-motion-aware orbit, with a fill variant available for development comparison. Journey rails explain their stops and state on hover/focus, and typed drafts use an in-app navigation confirmation. Lane pages share check evidence, remembered collapsible rails and file lists, Unified/Split/Inline word diffs, visible-line worker syntax highlighting, newest-first timelines and the delegate shortcut. Hosted Lane diffs fetch the selected file on demand. Local and hosted Review lead with Intent context, save cohorts, exact-View checks and acceptance decisions. Settings has Home-aligned navigation and role-aware controls. Diff views reuse visited pinned files and mount nearby rows for large hunks. Local Lane change summaries load progressively; hosted review byte caches retain current access and storage checks.

Hosted main is the only accept path for a project with server authority (the dogfood project since 2026-10-28). `nforge host --listen`, `--sync-agent`, `--auto-sync` and `--no-auto-sync` are refused with `CLI_UPGRADE_REQUIRED`, and no accept waits for a local owner receipt. The local owner HTTP server, native-owner recovery/reconnect and supervised owner release selection are removed. Hosted runner/cache recovery remains available; the retired native reconnect RPC returns `CLI_UPGRADE_REQUIRED` without writing. The six retired dev authority/publication tables are empty; definitions and restore readers remain for older backups. Revert creates an Intent and agent prompt for a checked compensating Lane, never a main rewind. A landed revert tells the reverted Lane (board note with its reopen command), marks its landing reverted in Lane status and `lane-history`, and puts a `reverted` notice on its Intent in Now and CLI status.

Project search (⌘K / Ctrl+K) reads Intents, Lanes, Views and available files through existing local and hosted APIs; empty search shows a short Needs-you/recent list and queries group up to five matches per type with Show all. Mobile has a search icon, full-screen palette and Now decision badge. Work headings share an inline collection switcher; incomplete filter counts and unavailable Planning counts are omitted. The top-bar Needs-you count shares Now’s decision source and session-local snoozes; Theme lives in the initials avatar menu as system/light/dark icons; the retired Appearance route redirects to General. Access shows names and handles, supports handle autocomplete and private pending email invitations redeemed at verified account setup. Contributions collapses to one sentence when empty.

- **Autonomy UI and notifications.** Backend policy APIs and away-summary preference are available; dedicated policy controls and notification delivery are designed separately. Native object checkpoints support hosted protected-path checks; legacy archive/Git path coverage can require person review. Git updates preserve untracked/ignored obstructions rather than overwriting them.

## Missing or unproven

- **Saved overlap precision.** Automatic hosted notices omit disjoint saved edits,
  identical results and resolve-origin/sibling self-overlaps. Shared symbol names
  alone do not block. Exact-base touching ranges and path-operation collisions
  retain blockers; unknown evidence reports incomplete coverage. The deterministic
  B1.5d fixture covers all 66 notices and 22 missed pairs using reconstructed final
  deltas; it does not prove timely delivery during live concurrent edits. Cross-file
  advisory notes (a changed exported symbol that a peer's changed lines use) were
  replayed on a 64-Lane overnight fan-out from final heads (0.036 notes per active Lane
  pair, at most 3 per Lane); live delivery is not yet measured.
- **Contract signal in every language (native).** TS/JS contracts are matched by import; Python, Java and Rust export changes, and any change to code in a language without export facts (contract unknown), hold optimistic landing by package through the manifest package graph, both ways, with the holding Lane named in `view.optimisticHold`. The contracts config lives in the root `forge.json` (`contracts.interfaces`). Hosted cross-file symbol notes remain TS/JS only. See [contract changes](agents/workflow.md#contract-changes).
- **First-write hooks.** First-write overlap hooks install on the first successful CLI command for Claude Code and Codex, with user/project off switches and an exact undo command. One Lane-independent hook resolves edited paths; hosted reads reuse the bounded peers query before the first save. Notices are advisory, cache per path/session, fail open within one second and exclude unsaved peer edits. Shell writes are outside coverage; hosted first-write delivery telemetry remains incomplete. See [first-write hooks](agents/workflow.md#overlap-before-the-first-write).

- **Agent value.** On a real repository with real agents ([B1.5d](research/b15d-report.md), 2026-11-04), Forge's time to main per task is 24-35% lower than Git + GitHub at N = 1, 3, 5 and 10, with no overall correctness difference, about a third of the CI minutes and fewer model tokens. Whole-batch wall time is a clear win only at N = 1; at N = 10 GitHub's median is lower. Overlap notices are mostly noise (13 useful of 45 blocking); precision is Phase 6 work. The earlier burst-landing numbers on [why Forge](why-forge.md#measured-landing-throughput) are historical.
- **Project deletion.** Deleting a project tombstones it at once: access, grants and runners are revoked; the owner can restore within 90 days (grants not restored); one scheduled call at the deadline, or owner-confirmed **Delete permanently now**, purges every project-owned row, file and R2 object in bounded pages, guarded by a schema inventory test. The R2 part uses a per-project scoped grant (owner-confirmed or expired purge only), never the global `FORGE_R2_MAINTENANCE` flag; pre-inventory tombstones are cleared with the lead's slug-confirmed `repurgeLegacyTombstone`. See [project retention](operations.md#project-retention-and-restore).
- **Import without a Mac.** On t3code (about 29,000 files) it takes 2 min 31 s and 2 min 37 s in two runs, until the project is agent-writable, within the 5-minute goal.
- **Legacy Convex file storage.** R2 is the only new byte path on every deployment and project (owner decision 2026-10-31); a guard in `npm run verify` fails any new Convex file-storage use. The dev-only full-content verifier streams both providers through SHA-256, and the [cleanup runbook](operations/legacy-storage-cleanup.md) covers full-table/recursive reference scans, exact sole-owner row pins, verified cursor migration, shared-file guards and bounded operation-id batches. The approved deleted bench project's 155,012 rows are removed and six cursor references are migrated. Three dev pause windows removed 92,650 files / 2,685,123,068 bytes in committed batches, including owner-approved class 4 files; every pause ended with the maintenance flags proven absent. Dev retains 16 files / 1,352,278 bytes, reached only from the cursors of source jobs stopped at the cutover; a reviewed owner-scoped tool settles such stale jobs and drops their dead cursors, and a later remaining-only run deletes the files. HEAD retry with page skipping, reliable resume and dry-run parity with the delete guard are in place (Issue 1323a44c). The CLI's Convex upload path is removed; legacy read and record-field allowlist entries remain while those files and the legacy `storageId` columns exist. Billed database/index totals and full cleanup completion remain open on Issue 40dad5e0; see [R2 backfill](operations/r2-backfill.md).
- Independent (non-owner) human acceptance testing; Edge and real coding-harness end-to-end runs.
- Managed execution, production deployment, public npm release, quotas, pricing, retention policy.
- Rename lineage across States; richer semantic relationships.

## Numbers worth knowing

- `scripts/perf-harness.mjs` records per-budget JSON for authenticated cold Now/Work, Lane first diff, bundle bytes and existing landing evidence (see [development](development.md#performance-budgets)). Live measurements require explicit `--live` and QA readiness marks; unrun results never pass. Full landing evidence distinguishes Intent lifetime from compose/check time and leaves unrecorded finish invocation duration unknown.
- Same-command hosted builds (`npm run build:hosted -- --manifest`) before/after route splitting: eager JavaScript 1,203,266 → 1,067,607 bytes (gzip 358,153 → 326,491); largest chunk 571,202 → 432,719 bytes; total JavaScript 1,649,242 → 1,660,218 bytes. These are build bytes, not measured page-load improvements. Manrope's Latin WOFF2 is 33,004 bytes versus the 164,700-byte TTF, with every original glyph retained across complementary subsets (73,708 bytes together). Retained monograms use lossless WebP; they are currently unused by the UI, so no browser transfer reduction is claimed. Live cold-load and Lane budget results for this slice remain unrun.
- Local contention fixture: a note invalidated 9/9 observed query read sets before and 4/9 after; paired writes returned `WORK_STALE` for 10/20 before and 0/20 after, with all notes retained. These are local dependency/serialized-transaction measurements, not live Convex subscription or OCC-retry measurements.
- About 690 test files. The landing check runs on free GitHub-hosted `ubuntu-latest` runners as a plan job plus test shards; a recent run took about 11 minutes wall (Issue 76ca1757). Shards are now balanced by recorded test durations (`7c3c9a70`); that change is not re-measured. Earlier Blacksmith, Modal and Mac timings were removed: Blacksmith use ended on 2026-10-25, Modal is not used, and the Mac check worker was stopped on 2026-10-29. There are no pushes to time: the push path was deleted.
- Changing a 16 MiB file uploads about 1.5 MB (content-defined chunks).
- Shared validation on a 31-root project dropped from 44 s to 0.4 s after the incremental validation work.
- Offline native hosting qualification (3,501 objects, 220 MB, 2,100 Work records, simulated 80 ms RTT): 211.9 s → 28.6 s (7.4×), usable at 12.6 s. Live-provider performance remains unverified.
- Estimated hosting cost: dogfooding $0–15/month; ~10 projects/30 agents $35–70; ~100 projects/300 agents $100–500 (Convex reads and file egress dominate). Estimates, not billed figures.

Canonical agent `abandon` closes Lanes or Intents with retained reason/actor/time, explicit save-first for dirty edits, optional Intent cascade and retry-safe operation ids. CLI and MCP share the behavior; exchange retains Work format 13 lifecycle history, hosted grey badges and closed filters. Reopen and capture-checked cleanup support abandoned Lanes.

CLI presence observers report coalesced file edits and queued/running checks without source reads or repository scans. Home discovers owner, contributor and reader projects with role labels.
On native owners, agent `link` (CLI/MCP) returns local cockpit and hosted save-pinned file URLs, including line selection. Saved-file readers use retained bytes without an index; checkpoint/finish receipts include Lane links.

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

The standard check supports conservative scope selection (off unless `FORGE_CHECK_SCOPED=1` is set;
hosted Actions runs under a gate other than full set it, and audit runs set `FORGE_CHECK_FULL=1`) from a runner-pinned
View comparison, packaged Markdown-only validation, streamed test progress and
recorded scope/reason/test lists. `FORGE_CHECK_FULL=1` forces the full suite. Old
runners without pinned comparison input continue to run full. Script changes follow
static imports, literal spawning paths and package-command consumers plus smoke;
standalone scripts add exact basename tests. Check-pipeline, packaging, build and
product-runtime script dependencies retain full coverage, as do uncertain scripts
or package commands. Selection evidence records the reason.

Any other configured check command receives the same runner-pinned changed-paths file
(`FORGE_CHECK_CHANGES`, also on hosted Actions). A check that declares `selection.scope`
may scope itself under a reduced-evidence gate and counts as scoped evidence, never full;
one that declares `selection.shards` runs as that many hosted Actions test jobs plus a
static job ([check command scope](workflows.md#check-command-scope)). Undeclared commands
run in full in one job. On GitHub Actions a check may declare `actionsToolchains` (Go, Python,
Java, .NET, Rust; a version or a version file) and `actionsCache` (dependency presets keyed on
lockfile hashes, saved only by main) as pinned workflow steps, and configured commands keep the
runner's toolchain-location variables ([toolchains](operations/github-actions-checks.md#toolchains-and-dependency-cache)).
App/OIDC runner repositories need the reinstalled `forge-check.yml` before a declared check plans.
Hosted check jobs log their fixed-cost phases (`plan: phases`, `run: phases`); a workflow may opt in to a
token-free planning step that also runs a single static check, and to a small control runtime cache
([fixed cost per check job](operations/github-actions-checks.md#fixed-cost-per-check-job)). Forge's own
`forge-check.yml` does not use them yet.

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

Hosted Lane opens admit FIFO workers across I/O phases without a global phase gate.
Opens below both the 4,096-file and 16 MiB logical-byte boundaries
reuse workers across phases after cache verification, retaining the editing
write-pass lease and
the shared per-volume worker ceiling, digest checks, independent inodes and
publication barriers. Cancelled or missing materialization tickets fail explicitly
instead of waiting indefinitely. Synthetic open qualification is local-only; it
does not establish a universal latency gain on other filesystems or under load.
