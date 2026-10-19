# Workflows

Everything runs on your machine unless a section says otherwise. Commands use `nforge`. From a source checkout, use `node dist/cli.js`. Mutating commands take a client UUID. If a reply is lost, replay the same command and UUID to get the original result.

## Native flow

```sh
nforge init-native ./project
nforge host ./project                  # optional: browse and review in the hosted app
```

The browser UI is the hosted app. Locally you work through the CLI, MCP and your editor. `nforge serve ROOT [--port N]` starts a token-protected local server for Git smart-HTTP (`/api/git/`) and the Work command API (`/api/work`); it serves no browser pages.

1. Create an Intent (an outcome with constraints) and one or more Lanes. A Lane is a directory.
2. Edit the Lane with your editor or agent. Checkpoint it. No Git staging is involved.
3. Select Lanes and compose a View. Independent file changes merge. If two Lanes change the same file, edit one Lane to hold the result, checkpoint, and pick it as the resolution Lane. Undo opens an earlier State in a new Lane.
4. Run checks on the View and accept it to a Channel such as `main`. A new Intent can start from an accepted Channel.

Capture includes non-ignored regular files with executable modes. Symlinks and special files are reported, not captured. Agents use the shorter flow in [agents](agents.md).

## Git-backed flow

For a Git repository with an initial commit, `nforge work /path/to/repo` gives the same Intent, Lane and View model. Each Lane is a Git branch and worktree (`forge/lane/<id>`). Stage the files you want, then checkpoint those exact staged files. A View is a clean merge commit of up to eight Lane heads, kept at `refs/forge/views/<id>`. Your checkout is never rewritten. Hooks are disabled and clean/smudge filters and custom merge drivers are rejected.

Work metadata lives in the Git common directory under `forge-work/`. To back up, export it with `nforge work ROOT > work-export.json` and keep a bundle of the Lane branches. Untracked and unstaged files are not in bundles.

Commands are JSON actions such as `intent`, `lane`, `checkpoint`, `compose`, `note`, `publish`, `import-pr`, `define-check`, `run-check` and `accept-channel`. Pass the revision from the last status. A stale revision, head or tree is rejected rather than overwritten. The full field list is in `src/work-types.ts`.

## Home and Settings

The signed-in Projects page combines hosted projects, GitHub imports, shared projects and shared source in one list. Yours, Shared with you, Starred and GitHub filter that list. Existing source bookmarks appear as stars and retain their saved source locations. Hosted-project stars are stored per account in the current browser; source bookmarks remain account-backed. Removed projects remain available below the list. GitHub analysis owners can use the row’s action menu → Remove. The confirmation names the repository and explains that removal affects everyone sharing the analysis, while GitHub is untouched. The analysis disappears immediately; bounded background cleanup removes its saved views, sharing, Zones, agent grants, interests and stored artifacts. Blobs retained by another analysis are preserved. Shared readers do not get a removal action.

Home includes projects owned by the account and current contributor/reader grants; shared projects show the account’s role. Reader discovery uses paginated `projectReaders.shared` grants and immediately reflects revocation and project removal. Deployments without this query continue to show owned and contributor projects; other query failures retain their normal error behavior.

Home and Settings share a centred 1120px page frame. Checks lists all recent seven-day runs and the latest main acceptance’s recorded checks in full, with all older definitions behind one disclosure. Historical one-off acceptance checks do not become current acceptance requirements. Commands use readable runtime names and repository-relative or home-relative paths; the original command remains in the hover text.

Project Settings uses a left navigation grouped into Project, Admin and You, with a page selector on mobile. General is the default. Autonomy edits the existing policy with a pinned prior policy and a retained operation ID for retry. Readers see policy and check values with “Only owners can change this”; owners retain policy controls and the check definition command. Protected paths appear as editable chips. Local Checks can define and edit commands; hosted Checks shows recorded definitions and outcomes. Access uses the existing owner/contributor APIs; it does not invent additional roles. General shows owner, visibility and creation date. Readers see these facts once in the table; owners also retain the project summary above their controls. Contributions and Transfer & backups retain the existing proposal and source handoff controls. Unsupported pages are omitted from navigation. Guidance, appearance, signed-in devices and existing lifecycle/backup controls stay available where supported.

## Reviewing a View

Review starts with the Intent outcome and its recorded notes, followed by Lane saves in build order. Select a save cohort to inspect the View’s final changes to the files touched by that save. Groups come from retained provenance; missing save authors remain unknown. The shared diff supports Unified, Split and Inline modes, viewed files and cached syntax highlighting.

Accepted and superseded Views show their retained disposition instead of decision controls; a superseded View links to its replacement and check status. The check record identifies the exact View and source head. Accept into main uses the existing Channel concurrency and autonomy policy checks. Ask for changes records feedback (a local View review, or a hosted Intent decision naming the View); it does not create a new acceptance requirement. Hand to an agent opens the review briefing sheet.

## Autonomy policy

`nforge policy ROOT` (also `nforge agent ROOT policy`) reads the typed `AutonomyPolicy` exported from the package. Local Work status and agent status include `autonomyPolicy`. The token-authenticated local HTTP Work API accepts `policy` and `set-policy` commands. MCP exposes them through `forge_work_overview` and `forge_task`. Hosted clients use `projectAutonomy.read` and `projectAutonomy.set`; `nforge hosted-work DEPLOYMENT PROJECT_ID '{"action":"policy"}'` and `forge_hosted_work` expose the same read/write commands without needing a Work index.

```sh
nforge set-policy ROOT '{"operationId":"UUID","preset":"trusted"}'
nforge agent ROOT set-policy '{"operationId":"UUID","acceptance":{"protectedPaths":["convex/**","**/package-lock.json"]}}'
nforge hosted-work DEPLOYMENT PROJECT_ID '{"action":"set-policy","operationId":"UUID","preset":"supervised"}'
```

A built-in preset replaces all settings; selecting custom retains the current fields. A field edit merges only the supplied fields and changes `preset` to `custom`. An optional `expectedPolicy` guards a settings edit against a concurrent change. Retrying the original operation returns its original policy receipt without reverting later settings.

- `supervised`: acceptance `review`, Lane updates `ask`, completion and cleanup off, away summary on.
- `trusted`: acceptance `auto-on-pass`, Lane updates `auto`, completion on, cleanup off, away summary on.
- `autonomous`: trusted settings with cleanup on.
- `custom`: individually edited settings. Existing projects without a stored policy use trusted settings under this name, with cleanup off.

`acceptance.autoActors` contains local actor IDs or hosted account subjects. Omitted/empty means all agents; it does not grant project authority. `FORGE_ACTOR` selects the local agent label (default: OS username). `acceptance.protectedPaths` contains case-sensitive, repository-relative globs (`*`, `**`, `?`, character classes and brace alternatives); additions, deletions, mode changes and both sides of a renamed path are covered. Matching changes always need a person. Automatic acceptance requires a recorded passing check for the exact View ID and source head. It cannot roll main back or omit its current accepted head.

The Autonomy setting `acceptance.disjointFastPath` permits native acceptance to
reuse current passing evidence across disjoint changes on newer main. It defaults
to off in new projects and presets. Enabled acceptance proves ancestry and exact
manifest-path disjointness, composes cleanly, records structured proof and schedules
a full main check automatically after acceptance. Pending main checks coalesce on
the newest accepted head. A red result stays in Needs you and creates one
“Fix main: <check> failed after <landing>” Intent per failing head, linking the run
and a copyable agent prompt. Repair from current main and check and accept the new
View normally; the worker never rewinds or auto-reverts accepted work. The option
does not change supervised person review, trusted passing-check requirements,
protected paths or actor selection. Scoped standard-check acceptances also schedule full main checks
while this option is off. See [agent workflow](agents/workflow.md#disjoint-fast-path-landing)
for receipts, queue recovery and the format-14 compatibility boundary.

Native owners can enable `ownerRootUpdates:true` with `nforge set-policy ROOT
'{"operationId":"UUID","ownerRootUpdates":true}'`. It defaults off in all presets
and older policies. Set it to false to stop automatic refresh. After each durable
acceptance into main, Forge updates the owner folder’s tracked files under the
owner lock, including composed disjoint and concurrent acceptances. Acceptance
receipts and local status report the refresh result and undo guidance. `.forge/`
source paths are never applied; existing metadata, untracked files and ignored
local content are preserved. Refresh adds its own recovery metadata under
`.forge/work` and uses private atomic replacement files under `.forge`.

Any tracked edit, deletion, mode change or untracked obstruction skips refresh;
acceptance still succeeds. Local **Needs you** shows the reason and exact
`nforge owner refresh 'ROOT'` command. Save or move local edits and obstructions,
restore tracked files to the last refreshed main named in the diagnostic, then
run that command. There is no force mode. Explicit refresh works with the policy
off and uses the same guard. Without a previous refresh receipt, explicit refresh
uses the retained bootstrap State as its initial baseline, so an untouched owner
can catch up after several acceptances with the policy off. An interrupted update
retains its exact old and new
States; retry or a later acceptance completes that target before advancing to
current main. Replaying an old acceptance never rewinds the folder. Refresh does
not change retained source history or the Work format.

With `laneUpdates:"ask"`, finish checkpoints and stops at `sync-required` with “main moved; run sync”. With `auto`, finish records each successful sync in Lane checkpoint/timeline data and returns “Updated from main: N files”, the changed paths and undo instructions. Git-backed Lanes use the same recorded sync/undo workflow, with hooks, filters and external merge drivers disabled. Untracked or ignored obstructions are preserved and reported. `undo-sync` for a local Lane takes its `syncOperationId` (successful or pending conflict) and returns its head to the pre-sync checkpoint. It leaves main and checkpoint history intact. Newer checkpoints or uncaptured edits cause refusal; explicit `force:true` captures dirty source before restoring the working copy and returns a warning. Retry uses the same operation ID. Restore main with `sync`, or materialize a retained newer State.

`lifecycle.completeOnAccept` controls completion of local accepted input Lanes and their Intent (when all its Lanes are complete); `keepOpen:true` leaves them open. Undo completion with `reopen`. The existing `lifecycle.cleanRegenerableCopies` switch enables automatic `lanes`, `lane-deps` and `check-workspaces` cleanup after local Lane completion or abandonment and accepted-work completion. Acceptance also sweeps eligible closed copies left from earlier work. Only Autonomous enables this switch by default; Supervised, Trusted and migrated projects keep their existing defaults. Completion and cleanup have retry-safe action receipts; replay does not complete or remove a subsequently reopened active Lane. Every automatic cleanup records removed paths, skipped items and reasons, and restore instructions. Completed or abandoned Lane folders are removed only when their source equals the retained head, no source operation is pending, and no local process is working there. Active, dirty, in-use and unverifiable copies stay. Automatic whole-Lane cleanup also retains excluded local settings and arbitrary ignored files outside recognized regenerable build directories. Source States, Lane records, saves, history, logs, artifacts, exchange staging and objects are retained. Run `reopen` with the Lane id to re-materialize its head; restore dependencies with `npm ci --ignore-scripts` and the project's build.

Terminal native checks retain the existing immediate cleanup behavior across presets. With cleanup enabled, after a terminal receipt is durable and published, the shared cleanup validator rechecks receipt/log/artifact durability, source equality, host and process state under the owner lock, then removes eligible workspace and private runtime directories. Its automatic-action receipt lists removals or reasons for retaining a copy; run evidence stays unchanged. With the switch off, the runner retains legacy cleanup without creating automatic-action records or promoting the Work format. Rerun the check to reconstruct its workspace. Missing or incomplete evidence, changed source, a running process or another host retains the copy. A local process working anywhere in the check directory retains both its workspace and private runtime together. A `DISK_LOW` refusal retains materialized workspace and runtime files through terminal handling and later automatic sweeps; explicit `clean` remains available. The cleanup switch also permits eligible leftovers to be retried by subsequent lifecycle cleanup. No age-based retention or background cleanup daemon is introduced. Custom auto-on-pass settings may retain this explicit cleanup opt-in. `notify.awaySummary` is a preference exposed for the separately implemented cockpit; it starts no notification transport.

Hosted policy is independent of uploaded local policy. Source exchange/return preserves hosted Channel receipts and cannot change hosted policy. A person can select a clean View without a prior local acceptance receipt (`acceptanceId` is optional). A person may explicitly select an earlier retained local acceptance for rollback; automatic acceptance cannot. Native object checkpoints support source-byte path/ancestry validation; legacy archives/Git checkpoints retain local View/acceptance provenance, and unavailable protected-path coverage requires a person. Hosted check records remain reports from the local execution owner, not independently verified execution.

Policy and reversible-action records use Work format 11; upgrade every local CLI, MCP writer, server and recovery reader before using this version to mutate a shared owner (acceptance, automatic lifecycle and sync records also write format 11). Older readers reject format 11. Existing owners without policy fields migrate lazily at read time to custom without rewriting their metadata or stopping concurrent older dogfooding writers. New native owners (including Git imports), new Git Work stores and newly registered hosted projects receive supervised. Deploy the new hosted schema/functions and upgrade all local writers together before relying on enforcement.

## Checks

In hosted Review, select a check and a connected computer you own, then request the run. Other people's runners are disabled. Current project owners and contributors may queue on their own runners; the project owner cannot queue on a contributor's runner. To check a contributor's proposal on the owner's computer, the runner owner queues it. The requester, runner owner or project owner can cancel or update a request while they retain project write access. Revoked contributors cannot act on retained requests. Retries keep the original operation UUID and pins. The canonical owner's **Re-check on latest main** path remains project-owner-only.

Checks run the exact View in a fresh workspace with a **clean environment**, including private HOME, XDG and temporary directories. Playbooks and automations use the same runner. Existing definitions need no migration and receive the clean defaults. Node/npm tools remain available through PATH, and npm uses a dedicated shared credential-free content cache outside HOME, so cached dependencies can be installed offline. The standard `scripts/forge-check.mjs` installs locked dependencies and runs verification using that cache.

Use per-check declarations for required parent settings:

```sh
nforge agent ROOT define-check '{"name":"integration","executable":"node","args":["tests/integration.mjs"],"env":["SERVICE_URL"],"credentials":["SERVICE_TOKEN"]}'
```

`env` and `credentials` contain environment variable names, never values. Both are explicit passthrough; the latter identifies credentials separately. They change the definition digest and appear in check definitions and receipts. They do not inject Secret Objects. Omitted variables are absent; failed runs suggest omitted names that may need passthrough. Values are not retained by the runner, but commands can print them into logs. See [security](security.md#clean-check-environments) for the complete allowlist and filesystem limitations. A clean environment is not an OS sandbox.

## Channels and releases

A Channel is a named pointer to accepted source. Accept a clean View with the expected previous head. A person can explicitly select an earlier accepted View to roll back. Automatic acceptance cannot rewind a Channel.

Local acceptance uses a **landing queue**: a crash-safe FIFO slot per owner and Channel, shared by finish and person acceptance through CLI/MCP/HTTP. Initial Lane checks and check-only work remain parallel under the machine check queue. When main moves during a finish check, finish releases the slot for the retry's sync → compose → fresh exact-View check, then rejoins only for acceptance with expected-head CAS. `finish.maxRetries` defaults to three retries after the initial attempt; waiting costs no attempts. Receipts retain all attempt pins/child IDs and observed queue positions (`waiting to land`). Conflicts, failed checks, policy-required review and exhausted retries stop explicitly. See [agent workflow](agents/workflow.md#landing-queue) for replay and bounded observation.

Supervised projects still require a person. If main moves before a person's acceptance, it returns `CHANNEL_CHANGED` (or `CHANNEL_DIVERGED` for a View missing current main) with “main moved; re-check needed”. Sync and check a new View, then review and accept that View; no prior approval is carried forward. Explicit person rollback to an earlier accepted View remains available. This queue coordinates local writers on the same owner; upgrade all those writers. Hosted Channel selection retains its hosted authority/concurrency rules.

- **Export:** each acceptance exports a full Git bundle. `git clone --branch accepted FILE.bundle copy` restores ordinary Git source.
- **Releases:** a named source release pins an acceptance. It can include finished build runs, whose output files are kept with hashes. Export writes a manifest and a source bundle. Restoring a release gives source only, with empty Work.
- **Git URLs:** the local server serves clone and fetch for accepted sources over loopback HTTP, authenticated with the server token as a bearer header. Pass the token through `GIT_CONFIG_*` environment variables, never in the URL. The clones carry full tracked history.
- **Contributions:** clone, commit, then push to the contribution URL shown under an Intent, or hand back a bundle with `import-bundle`. Either creates a separate Lane and never moves a Channel.
- **Netlify draft:** upload selected retained build files as a draft on a site you name, using your local Netlify login. There is no build step and no production promotion. Preview environments are local pointers to retained drafts that you can move forward and back.

## Hosted project and companion

A hosted project stores checkpoints you push and its own journal of Intents, notes and Channel selections. Execution stays local.

```sh
nforge login https://DEPLOYMENT.convex.cloud
nforge host ROOT                         # native or Git-backed; private by default
nforge host ROOT --status
nforge exchange ROOT push                # current local revision, current hosted backup as previous
nforge hosted-work ROOT '{"action":"workspace"}'
nforge coordination ROOT '{"action":"sessions"}'
nforge exchange ROOT pull --target NEW_DIR
```

`host` creates the project, sends only missing source/Work objects, starts hosted Work and builds its
current index. The project URL and next steps are printed together. No archive upload, copied IDs,
command file or browser initialization is needed. `--deployment URL` selects a backend; otherwise
Forge uses the saved login deployment (or `FORGE_DEPLOYMENT_URL`). `--name NAME` changes the hosted
name and `--visibility private|public` selects visibility. Public projects permit signed-in read
access; changing Work still needs owner/contributor authority. New hosted projects use H6’s `supervised` autonomy policy; owners can inspect it with
`nforge hosted-work ROOT '{"action":"policy"}'`. Hosting needs a device login with
`cli` scope; a coordination-only login cannot create or upload projects. Execution stays local.

The owner records its deployment and project ID privately alongside Work. Re-running an interrupted
`host` or bound push resumes the original UUIDs and pinned snapshot, including after a lost reply;
objects already stored are reused. `--status` reports the binding and any pending hosting operation.
Hosting a completed binding again is refused; `--new` explicitly creates and selects another project.
Re-running an interrupted `--new` resumes it. The previous binding stays usable while the new host
is pending, and unfinished pushes keep their original per-project pins (shown by `--status`).
Completing an old push cannot overwrite a newer binding. Local source, Lanes and Work revisions are unchanged.
Git-backed owners preserve Git history and Work and transfer their source bundle via the same
missing-object/chunk exchange; no compressed Work archive is generated or uploaded.

Native hosting publishes the bootstrap and current accepted `main` State's files, every retained
State record and the complete Work metadata first. Once the cockpit index is ready, the command
prints its URL and continues older blobs, logs and artifacts in a detached local backfill process.
`nforge host ROOT --status` explicitly reports **history backfilling**, its last observed counters
and any recorded error code. Current source and Work are usable then; historical file reads and
full recovery become available as their objects arrive. The pinned full manifest and operation
UUID stay unchanged. Completion validates every retained content pin before clearing the hosted
checkpoint's `historyBackfilling` flag. It does not move hosted Work or erase concurrent edits.

Human progress goes to stderr: phase, completed/total objects and bytes, throughput and ETA.
`nforge host ROOT --json` streams JSON lines (`host-progress`, then `host-result`) for tools;
`--wait` keeps the command attached through complete history transfer. Preparation and server-side
indexing emit phase heartbeats; their byte totals/ETA remain unknown until measured. Counters for
uploads count completed logical transfers, while the final result counts actual physical bytes
and objects (including chunks). Reused objects need no upload. Progress contains no source text,
authentication values or storage URLs.

Re-running `host` resumes a pending snapshot even if local Work advanced. It can recover a stopped
background process; `--wait` follows that recovery. Backfill runs on this machine, so shutdown,
network loss or expired login can pause it. Restore login to the same account and rerun `host`.
The status timestamp is a last observation, not proof a worker remains alive. Git-backed owners
currently complete their bundle transfer before becoming ready.

### Direct GitHub hosting design (not implemented)

A future `nforge host ROOT --from-github` should read the Git origin, resolve the exact local
commit and retained refs with hooks disabled, and send repository identity and those pins under
the original hosting operation UUID. The hosted side must check current repository access through
`convex/access.ts`, reuse the public/private import acquisition in `convex/imports.ts` and
`convex/indexer.ts`, and reuse the public Netlify `analyze-background` handoff. Private imports
continue their current authenticated Convex path; private source/tokens must not enter the public
worker. Credentials stay in the existing hosted integration, never CLI arguments or progress.

Those paths currently produce a selected source/analysis artifact, not a full Git history bundle
plus Forge Work. Connecting them directly would silently omit local-only commits, refs, Work,
logs and artifacts. Extend the importer to write project-scoped exchange objects and the exact
retained Git closure, reporting the same progress/completion pins. Upload only local-only source
and Work through the client exchange, then verify the union against the local manifest before
binding the owner. Preserve operation receipts on lost replies, and fail explicitly on changed
repository/head/access; do not silently switch to uploading everything. Test public/private
access revocation, inaccessible commits, local-only history and interrupted import recovery before
exposing the flag. Ordinary `host` remains the implemented path.


Bound pull reads the selected hosted Work checkpoint plus its matching journal and restores into a
new owner. Without `--target`, its sibling name is `ROOT-hosted-BACKUP_ID`. The original owner remains
intact and the new owner receives the binding. A push stores a new backup; the existing source-return
flow explicitly selects it for hosted Work (see [source exchange](operations/source-exchange.md)).
Commands with explicit deployment/project IDs and request files remain supported.

In the browser you can create Intents and notes against the hosted source and pick source for a
hosted Channel. Edit, check and accept locally, then return the new checkpoint. If hosted edits
happened meanwhile, both sides are kept and you reconcile before returning again.

An owner that kept working after a return can receive hosted changes without a fresh restore. The `reconcile-hosted-work` action takes the common archive and the original journal, merges hosted Intents and notes, and leaves local Lanes and checks alone. A status conflict is reported and changes nothing.

## Contributor proposals

The project owner adds a contributor by account ID or email. The contributor opens the project from "Shared with you", creates an Intent, downloads the matching journal and source archive as a pair, and restores them locally. They edit, compose a clean View, export the archive and upload it as a proposal from the Proposals tab.

A proposal is visible, including its contents, to everyone who can read the project, like a pull request. It moves nothing. The owner downloads it and runs `import-native-contribution` with the archive path, hash and candidate State. This creates a separate Lane. The owner composes, checks and accepts it normally. The contributor's checks and reviews stay as provenance. Contributors cannot write source or Channels directly.

## GitHub

### GitHub sync MVP

Native `main` can keep an existing GitHub branch current even when native and Git history are unrelated:

```sh
nforge github-sync ROOT --repo OWNER/NAME --dry-run
nforge github-sync ROOT --repo OWNER/NAME --push
# Subsequent runs use the stored repo/branch binding:
nforge github-sync ROOT --dry-run
```

The default is `--dry-run`: it reads the remote and prints JSON with the target ref, commit messages, attribution, State/acceptance/View ids and changed files per commit. It pushes nothing and does not change Work metadata. `--branch` defaults to `main`; it selects the GitHub destination, while the source is always accepted native `main`. Pass `--repo` on first use for native owners outside a Git checkout; otherwise Forge can use `gh repo view` to resolve it.

The first push stores a binding in the owner's Work metadata: repository, branch, adopted GitHub commit and native State → GitHub commit mappings. It writes one `Adopt Forge native main <state>` commit with the accepted State's tree and the current GitHub head as its parent. Later pushes write one commit for each subsequent native `main` acceptance in recorded acceptance order, including empty-tree changes. Each commit uses that accepted State's tree, its Intent outcome, acceptance/View ids, and the previous synced Git commit as parent. Unaccepted Lane/root edits and capture-excluded files are never read into a sync tree. Previously tracked files retained by native capture remain part of the exact accepted tree, including source modules whose names match capture heuristics.

Incremental commits use H8's accepting actor name when recorded and the configured Git email; older acceptances use the configured Git identity. Agent contributors/acceptors receive `Co-authored-by` trailers (local attribution is a declaration, not verified GitHub identity). A repository's lead co-author convention can be supplied through `FORGE_GITHUB_SYNC_COAUTHOR` or Git config `forge.githubSync.coAuthor`, in `Name <email>` form. For this MVP, configure `user.name`/`user.email` (or the sync identity below) and use your existing Git credential helper or `gh auth` login. Phase 3 will use the Forge GitHub App.

**Empty repositories.** If the destination branch does not exist (an empty repository or a new branch), the first push writes the `Adopt Forge native main <state>` commit as a root commit with no parent. The branch is created with an exact "must not exist" lease; if someone creates it first, Forge reports **GitHub changed outside Forge** and overwrites nothing. The binding records an empty adopted commit; later acceptances fast-forward from the root commit as usual.

**Rebinding.** Without `--rebind`, a bound owner refuses another repository or branch. To move the owner to a new destination:

```sh
nforge github-sync ROOT --repo OWNER/NAME [--branch B] --rebind            # dry-run: shows what would change, writes nothing
nforge github-sync ROOT --repo OWNER/NAME [--branch B] --rebind --push
```

`--rebind` requires `--repo` and replaces the stored binding with a fresh one (adopting the current accepted `main` into the new destination). It refuses with `GITHUB_SYNC_PENDING` while the current binding has an unfinished operation; reconcile that first. The replaced binding, with its State to commit mappings, is kept in Work metadata as `githubSyncHistory`. The automatic mirror policy is not changed: if it still points at the old repository, the output says so, and you update it separately with `set-policy`.

**Sync identity.** Sync commits (author and committer) use `FORGE_GITHUB_SYNC_NAME` / `FORGE_GITHUB_SYNC_EMAIL`, then Git config `forge.githubSync.name` / `forge.githubSync.email`, then `user.name` / `user.email`, each resolved independently. This keeps a personal address out of public history without changing your global Git identity, for manual sync and the automatic mirror alike (for example `git config --global forge.githubSync.email ID+USER@users.noreply.github.com`). Where an accepting actor name is recorded it is still the author name; only the email source changes.

A push only fast-forwards the exact recorded GitHub commit. An exact ref lease protects the check/push race; ancestry is checked before sending. If the destination moved, Forge reports **GitHub changed outside Forge** and preserves both histories. It never replaces unrelated history. Branch protection/Actions remain GitHub's decision; the MVP does not open or merge PRs.

Pending commit identities and an operation UUID are saved before sending. After a lost reply, rerun `--push`: Forge reconciles an already-pushed batch through its saved mapping before preparing later acceptances. Optional `--operation-id UUID` replays a selected original batch, including after later syncs; retain the UUID printed in the plan/receipt. A failed push retains its original pending batch. Automatic publication is off unless enabled by the project policy below.

### Automatic main mirror

Enable on the native owner through CLI or the agent MCP `set-policy` action:

```sh
nforge set-policy ROOT '{"operationId":"UUID","githubMirror":{"repo":"OWNER/NAME","autoPush":true,"laneRefs":false}}'
```

The setting defaults off and survives autonomy preset changes. Set `autoPush:false`
with the same repo and `laneRefs:false` to stop future automatic attempts. Publication
uses the existing local Git/gh credentials; it does not require a new login path.
Only main is published. Lane refs remain unpublished.

Acceptance queues a detached worker and returns without waiting for GitHub. The
worker coalesces a short burst, then mirrors the newest green main. Unchecked
human acceptances wait for an exact passing check; scoped/fast acceptances wait
for their full post-accept main check. Each acceptance still has its own mapped
commit. The acceptance and pending mapping survive worker interruption; a later
acceptance, check completion or local status observation resumes pending work.
Transient failures retry the original operation with exponential backoff up to
one minute between attempts. Disabling the policy stops future attempts; an
already-sent Git request may still complete.

Automatic projection also omits paths protected by capture's sensitive-name and
private-directory rules even when an imported State retained them. The mapping
records those omitted paths for exact retry. Manual sync retains its existing
exact accepted-tree behavior. Accepted source is never changed by publication.

Local Work status and hosted Settings → GitHub show progress, retry state,
and the last successful push. A changed remote or failed exact lease becomes a
Needs you conflict with Forge's State and Git head, the expected remote head and
the observed GitHub head. Neither history is overwritten. Reconcile explicitly;
manual `github-sync --push` can reconcile a retained pending operation after the
remote history has been resolved. Published source is undone by a compensating
Lane, never by automatically rewinding GitHub.

See [Phase 3: full sync mode](roadmap.md#phase-3--decide-scope-with-data) for PR translation, incoming GitHub changes, Actions checks and conflict reconciliation.


- **Publish:** in a clean View, choose a repository and optional base. Forge pushes the View's Git projection to `forge/publish/<operation-id>` and opens a PR using your local `gh` login. It never merges. "Check GitHub PR" records the provider's state. Acceptance is reported only after GitHub confirms the merge.
- **Import a PR:** paste a PR URL. This reads with your local `gh` access and writes nothing remotely. It creates an External Intent with the PR's exact head and base. "Create native View" then selects that head. Later pushes appear as new observations. Nothing is absorbed silently.
- **Mirror:** copy an accepted Channel's full history to a new branch `forge/mirror/<id>` in a repository you pick. Existing branches, PRs and `main` are untouched. An optional destination can fast-forward a named branch from an exact previous commit. It is never forced.
- **Export to Git:** `nforge export-native-git OWNER STATE DIR` writes a repository and a mapping from States to commits. `nforge import-native-git REPO COMMIT DIR` imports with history kept.

## Now, Code and Home

The hosted project opens on **Now**. Needs you holds decisions, direct messages, questions and handoffs addressed to the viewer; broadcasts remain in Activity and their scoped conversations; What's changing shows work in motion, with count links to decision Lanes and Accepted today instead of duplicate rows. Lane titles wrap to two lines, with the Intent below and a compact owner name. Quiet Lanes expand from one summary line. Now shows the agent session name when available, otherwise its recorded name or “Agent”, without a second agent badge. Overlap chips wrap beside the file and Compare action; file tooltips hold the advisory detail. Accepted today uses one quiet attribution/check-duration line, including its actor and automatic label, with undo details on hover. Titles resolve the accepted View’s Lane inputs and pinned View dependencies. Cancelled and interrupted checks use static grey status; only queued, preparing and running checks animate. Activity under Now records saves, checks and acceptances, with pending questions and handoffs kept in Needs you. A failed check on a superseded View is grey and links to the later View; “fixed in a later View (passed)” requires a passing check there. The project strip and Home use the native main Channel and its acceptance receipt for native projects, retaining hosted selections for Git projects. Home’s recent list shows one newest entry per Intent. Mobile Now shows only decision and in-progress counts. Live sessions, claims and messages update as they arrive.

Above 20 rows, Now’s changing Lanes and Work’s Intents, Lanes and Views collapse into recorded Initiative groups. Intents without an Initiative remain in No Initiative. When an Intent is linked to several Initiatives, its primary group is the first by Initiative record id, so totals do not double count; Planning retains all links. Groups print exact observed counts and open five rows at a time. Needs you groups by decision kind at scale. People, overlaps and accepted groups also have continuation. Small lists keep their ordinary rows. Planning search also matches an issue’s Initiative title; a matching Initiative with no matching issues remains selectable. Hosted presence reads continue beyond the first 30 roots, and Activity can load earlier events beyond the first 40. Saved source views do not store cockpit filters; ownership areas, labels, maintainer queues and batch actions are not available.


Journey rails show four stops: edited, saved, checked and accepted. Hover or focus a rail for its current state; the Progress header’s (i) explains the stops. Project names have no mode badge.

Application loading uses the Forge mark on the chosen theme, with a single 620 ms arrival (static with reduced motion). Same-page links navigate in place. Typed Intent, Lane-name, note, reply and message drafts offer Keep editing or Discard and leave in the app before navigation; saved or empty inputs and pending network activity never trigger that confirmation. Closing or reloading the document uses the browser warning only for these unsaved drafts.

Imported repositories open a source explorer with Files, Overview and Docs views. Files shows bounded source pages with digests and a file inspector for imports, declarations and identifier references. Links carry a source state, so a stale link asks you to reload. The page polls for changes and offers Re-index when the importer can refresh.

An optional `.nforge/home.md` becomes a Home tab. It is ordinary Markdown with `forge` code blocks such as `{"component":"coverage"}`. Components are `coverage`, `imports`, `impact`, `source`, `work`, `evidence` and `releases`. A block can only show data. It cannot run commands or read outside the selected source. `work`, `evidence` and `releases` describe local Work records, which hosted source snapshots do not include, so those blocks show their original text. This repository's own `.nforge/home.md` is an example.

### Lane screen

Lane pages show the edited → saved → checked → accepted journey, the next step, exact-View check evidence, file changes, and a newest-first timeline. They also show the Lane's live conversation. The delegate sheet opens from **Hand to an agent** or **⌘⇧C** (Ctrl+Shift+C on other keyboards).

The Timeline/Conversation column and file list collapse to 36px rails on desktops; the controls remember `forge.lane.side` and `forge.lane.files` in browser storage. Below 1060px both panels remain expanded. **Unified**, **Split**, and **Inline** word diffs share the selected file's comparison and remember `forge.diff.mode`. Changing modes does not fetch source again. File selection loads that file on demand; counts unavailable from a manifest remain absent until known.

Syntax highlighting loads the JavaScript/TypeScript, Python, Java or Rust grammar only when visible code requests it. Parsing and the blob/range token cache run in a module worker. Source appears immediately as plain text; unknown languages, worker failures, truncated comparisons and files above the highlighting threshold keep readable plain text. Syntax classes are scoped to `.diff` and `.source`.

## Planning, Activity and Code

Planning groups Issues under Initiatives, with status and linked-Intent filters, discussion and retained history. Readers can browse hosted planning records; owners edit them. Activity groups recorded events by day, folds consecutive saves from the same Lane, and links pending decisions to Needs you. Filters and exports use the loaded records; Show more reveals additional loaded events.

Code opens Files. Native hosted projects browse the exact `main` head through the existing authorized source-review reader: the manifest populates the expandable tree, and source text is read on demand in pages. The Imports inspector resolves static relative JavaScript/TypeScript imports and re-exports from the loaded source page only. Other relationships remain unknown. The folder-card Graph mode is removed; identifier reference maps remain available from the indexed file inspector. Imported GitHub repositories retain their source reader.

Settings › Transfer & backups groups local work, source return and archive import into three sections. Copy agent prompt starts local handoff; the Work journal and source pull request downloads share a row, with restore instructions disclosed below. The return checkpoint selector includes its own Load more choice beside Return to Forge. Source verification is disclosed below that row. Archive import uses an English file button and retains private backup history.

The project top bar opens search with ⌘K (Ctrl+K on other keyboards). Search matches current-project Intents, Lanes, Views and available indexed files, with up to eight Needs-you and recent entries before typing. Queries group Intents, Lanes, Views and Files, showing five per group with a Show all action. Views use their composed work as the title and keep their number secondary. Files use the latest indexed main acceptance (or the checkpoint source when main has no acceptance), pinned to that checkpoint and head when opened. File-read failures leave Work results available. The Needs-you pill counts the same visible decisions as Now, including session-local “Not now” choices, and opens that panel. On mobile, the top-bar search icon opens a full-screen palette and the Now tab carries the Needs-you badge. The avatar menu identifies the signed-in person by name and handle, links to Profile and Signed-in devices, contains system, light and dark theme icons with tooltips, and exposes the existing Clerk sign-out action. The retired Appearance settings route redirects to General. Work collection headings read “Work”; their inline segment names the current collection. Filter counts appear only once the existing collection reads are complete; unavailable Planning has no count.

Work’s Intents, Lanes, Views and Planning switcher sits beside the page heading. On narrow screens it scrolls horizontally directly below the heading; it does not wrap or occupy a separate navigation band. Counts reuse the hosted workspace’s existing collection counts.

### Lane and View file Map

The changed-files panel has a Files | Map toggle. Map imports its renderer and requests graph data only after a click, then retains it for that mounted exact head. It reuses the Code renderer and static relative JavaScript/TypeScript import parser. The map includes every touched file and its direct imports/importers from the base and head, including deleted files; unsupported and dynamic relationships remain unknown. Added, modified and deleted nodes use distinct labels/colours; node width follows changed-line counts. Other open Lanes mark shared paths, with names on hover and in keyboard labels.

Above 50 touched files, Map starts with expandable directory groups. Collapse folders appears at the right of the Files | Map toolbar while folders are expanded. The canvas fits its content between 240 and 560 pixels, then scrolls internally. Peer markers and their legend share one colour; hovering a marker names the other Lanes. Click or Enter/Space selects a file's diff; untouched neighbours show the unchanged comparison. At narrow widths Map fills the panel and scrolls vertically, without requiring pinch or zoom. Collapsed folders retain every file. Hosted native Maps use the checkpoint-authorized source-review action and need its Map-capable backend deployed.

### Browser feedback and conversations

Failed Intent notes and Lane creation keep the draft. Hosted retries reconcile an unknown earlier
operation using its original payload before applying a different action. Request changes records
feedback against the exact View and sends it to its input Lanes, targeting their reporting session
when available. Lane and Review conversations show sent messages and explicit acknowledgements;
a heartbeat alone is not evidence that a message was seen.

Who's working offers Message and Hand off for each session. Review retains the full line-comment
browser. Session messages open a
compact dialog. For unbound sessions, Copy message copies the draft and then names the session to
paste it into. Failed feedback shows one inline error beside its control; transport details are
available on hover, and an uncertain write asks the reader to check whether it was saved.

### Source links and browser navigation

Copy link on an Intent, Lane, View, save or source file retains its source head.
Save links open immutable saved source in the Code frame, with the save shown in the Source picker; file links include an exact `#L` line anchor.
Hosted links also pin the retained source checkpoint. Get code opens that saved
source or Settings → Transfer & backups; it does not claim that restoring an
archive adopts a later hosted main selection.

Work segments, Intent filters, diff file/mode, and Code file filters/scope are URL
state, including browser back/forward and reload. Failed source and diff reads have
Retry controls. Lane readiness refreshes when either its saved head or main moves.

Settings → GitHub shows the last recorded published main and publication time
(older records have no recorded time), with the existing `github-sync --dry-run`
and `--push` commands for the source machine. After a successful push, a bound owner publishes the latest repo, branch, head and
time to hosted Settings through metadata sync; no source transfer is needed. If
that publication is deferred, retry `github-sync ROOT --push` to reconcile the
recorded push. The optional existing Work binding keeps the same format. Local General links to its bound hosted project for account/device and
access administration. **New project** in the hosted browser creates a private
project with an empty immutable State, initialized Work and a `main` Channel,
without a local machine. Creation retains its operation UUID across retries;
reusing it with a different name is refused. The next-step prompt appears after
creation: add an agent or import an existing project archive. It can be dismissed.
The empty project uses the same retained object checkpoint and indexed Work as an
uploaded native project. Its initial main receipt remains source authority but is
not counted as a completed code change in Now. Agent source-writing Lanes still use the existing local
workflow. GitHub imports remain read-only code analysis, without an editable Forge main.

For the signed-in owner's existing Clerk username, canonical project URLs use that
username and replace the older ID URL in the browser. Other owners keep their
recorded account ID when no username is available to this client; display names
are never turned into invented account handles.

GitHub Settings shows the recorded sync repository (or a single recorded import repository), with labelled Preview and Publish commands. Without a recorded repository it shows Not connected to GitHub and a Preview command with a REPO placeholder. Saved-file read failures keep the Code file tree and breadcrumb visible while retrying the pinned save.

### Check output in the browser

Lane and Review offer one byte-paged log reader with stdout/stderr selection, First failure,
refresh and copyable line links pinned to the run and retained page. Failure rows have a tinted background and rail; First failure scrolls to and focuses the match. The quiet gutter counts 1-based lines from retained output and links to `#L` anchors; byte offsets remain internal paging pins. Running local checks show partial
output; terminal cancelled/interrupted runs stay static. Local reruns retain the View head and
check definition. Cancel reports the returned outcome, including a run that finished before the
request arrived. Hosted Review keeps connected-runner requests alongside the retained check
record. Hosted output reads the selected object checkpoint; when the log is only on the runner
(or in a legacy archive), the log reader provides `nforge agent ROOT log` with the exact run ID.
Replace `ROOT` with that computer's Work owner. Source return makes retained output available;
it does not stream remote machine bytes. Scope labels appear only when recorded scope is available.


### Settings and outside contributions

Access lists people by name and @handle with an avatar, without email fallbacks. Owners can autocomplete an existing @handle or enter an email address. An existing account receives contributor access; an email without an account creates a pending invitation, visible only to the project’s access manager. No invitation email is sent. When the recipient signs in with that verified email, account setup reconciles the invitation into contributor access. Invitations retain operation identities so retrying a completed invitation does not restore access after removal. Pending invitations can be cancelled.

Contributions lists outside contributors’ proposals. With no outside contributors or proposals it shows one quiet sentence. Contributors with a selected Intent can send changes from their computer through the existing archive proposal flow.

How agents work has project guidance included in every Forge briefing after the repository’s AGENTS.md/CLAUDE.md, and personal guidance for agents the account starts in every project. Autonomy uses the shared switch control; its existing policy and save behavior are unchanged.
