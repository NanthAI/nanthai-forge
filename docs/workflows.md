# Workflows

Hosted projects acquire source, compose and land through the hosted backend. Your CLI and editor operate on local checkouts. Follow the [hosted GitHub-import quickstart](quickstart.md) for the development installation and entry point. Commands use `nforge`. Mutating commands take a client UUID. If a reply is lost, replay the same command and UUID to get the original result.

## Hosted flow

Forge has one client mode: hosted. `nforge host ./project` makes a Git folder (or any directory) a hosted project, and `nforge clone` checks one out; agents and people then work in its clone and Lanes. A folder without a hosted marker is refused with `FORGE_ROOT_UNAVAILABLE` and the `nforge host` next step. Lanes keep working offline and land once back online.

1. Start a Lane from an Issue or an outcome (`nforge agent ROOT start`). A Lane is a directory.
2. Edit the Lane with your editor or agent and save it. No Git staging is involved.
3. `land --save` composes the Lane with current main into a Candidate, runs the project's check on its runner and lands it under project policy. Independent file changes merge; overlapping edits open a conflict Lane to resolve.

Capture includes non-ignored regular files with executable modes. Symlinks and special files are reported, not captured. Agents use the shorter flow in [agents](agents.md).

## Browser review and hosted landing

The Candidate review puts **Your decision** above its check record and conversation.
**Accept into main** submits the exact reviewed Candidate to the hosted landing
queue as a person. It does not contact an owner machine. The page subscribes to
that Candidate's submission and shows Queued, Checking, Landing, Landed or the
retained failure. Where the page's own read shows that no check ran on the Candidate (or on a landing held for review), one plain line beside **Approve and land** says so ("No check ran yet; it will be checked before landing."). It is a fact, not a confirm step: Approve acts at once, and a person keeps the ability to approve an unchecked Candidate. Needs me and the Lane page carry no check data in their read, so they do not show the line. Reading progress starts no work and uses no polling timer.
A main race recomposes the immutable reviewed input/dependency roots through the
ordinary hosted finish driver; later Lane saves are not substituted. An existing
exact passing check is selected when available. Unchecked acceptance follows **Who can land without a check** in
**Settings → Landing & checks**. The default is Owner only; the owner may instead
choose named people or existing teams, or all current write members. A selected
person must still have write access at landing time; team selection grants no
project access. Revocation takes effect immediately. Agent credentials always need
a passing check. Protected-path and review rules continue to apply.

**Cancel landing** cancels the submission separately from its Lane or shared check.
A hosted landing with no progress for 15 minutes gets a stall alarm naming the
step and the missing owner. If it still makes no progress 60 minutes after its last
progress and nothing is left to drive it, Forge ends it as `terminal-failed` with
`LANDING_STALLED`, so the requester gets an outcome; an entry waiting for review or
a dependency is never dropped this way. A step that keeps failing (its task lost or
crashing on every retry, including the completion of a check that already ended) is
re-driven by supervisor rounds; after two failed re-drives Forge ends the landing with
`LANDING_DRIVER_EXHAUSTED`, and the finish result names the retry command.
`tests/landing-failure-injection.test.mjs` injects a transient and a permanent fault at
every landing step. See the [landing queue](agents/workflow.md#landing-queue).
**Ask for changes** opens inline, keeps a draft per Candidate during the browser
session, and records feedback in the Intent and selected Lane conversation. It is
advisory and adds no acceptance gate. Accepted versions links to this same review
surface instead of offering another acceptance route.

**Revert…** opens an inline confirmation. The source service prepares a reverse
Lane from the actual acceptance receipt, composes a new Candidate on current main,
and submits it to the same checked landing queue. The optional Why is retained in
the revert Intent. Later disjoint landings remain; conflicts surface in the reverse
Candidate. Main is never rewound. The original Candidate retains its Accepted
outcome and links to its reverse submission. Source preparation/composition use
finite job subscriptions; the landing queue continues independently once submitted.
The Hand to an agent prompt remains available as a secondary route.

For a CLI revert, run the printed wait from the same folder. It follows the
original operation and returns the reverse Lane when ready. An `IN_PROGRESS`
reply repeats the same wait command. The reverse Lane can then be landed through
the normal checked flow.

In the app, the same revert is one press, **Take it out of main**,
on a landed Lane's review page, its landing check and its proof page (one shared
control, `web/src/app/take-out.ts`). It keeps one operation id per landing for the
life of the page, so a press retried after a lost reply, or pressed twice, makes one
reverse landing. Lane review then links the reverse Lane's landing check, where its
checked landing and replay state show; the original Lane and its receipt stay
reachable and show it as taken out. The word (Undo or Revert) and whether a revert of
a failing main may go first in the queue are open owner questions 48 and 49
([journey 35](ux/journeys/35-undo-for-a-person.md), Item 581bd373); until they are
answered the press uses the approved design's words and the ordinary queue.

While a landing's check is still running, its landing check page offers **Read the
output so far**: the newest chunk each runner has published, read once when pressed
(one streams query, one signing mutation, one object read per output stream).
**Read newer lines** reads again. Nothing is pushed or polled, so an open page
nobody presses, or a hidden tab, makes no calls. Agents read the same data with
`nforge agent ROOT log {runId}` ([workflow](agents/workflow.md)).

## Who can land without a check

The web setting and CLI edit the same `acceptance.withoutCheck` policy. Omission
means `owner`. Modes are `owner`, `selected` and `writers`; every mode includes the
owner person. For selected people, use Forge handles (`@handle` or `handle`),
which are stored by account. For teams, use an existing team name or team id.
A team member also needs current project write access; this setting never grants it.

```sh
nforge agent ROOT check-settings '{}'
nforge x ROOT set-policy '{"acceptance":{"withoutCheck":{"mode":"selected","people":["@release-person"],"teams":["Release team"]}}}'
nforge x ROOT set-policy '{"acceptance":{"withoutCheck":{"mode":"writers","people":[],"teams":[]}}}'
nforge x ROOT set-policy '{"acceptance":{"withoutCheck":{"mode":"owner","people":[],"teams":[]}}}'
```

`check-settings` includes the effective setting. Policy changes retain their old
and new values in project history; **Landing policy history → Undo** restores the
previous selection through the same retry-safe policy writer. An agent sign-in's
setting edit follows the existing owner-approval policy; changing this setting
does not let an agent land without a check. The stored-field rollout is reader
compatibility first, writer second.

## Hosted acceptance gate

`acceptance.gate` is optional: absent or `full` keeps the full gate. Existing
policies are unchanged. Explicit trusted/autonomous presets select `contract`;
editing another setting retains the selected gate when the preset becomes custom.
The check-settings policy and status run's optional `gate` identify the configured
and effective gates. This table describes each actor class; the same rules apply
when reviewing a Candidate in the browser.

| Actor or Candidate | Effective gate |
| --- | --- |
| Owner's trusted or autonomous agents, permitted by `autoActors` | Contract when eligible; otherwise full |
| Supervised (`mode: review` or `gate: full`) | Full plus person review |
| Outside contributor | Full plus current public-governance rules |
| Intent without a contract | Full |
| Protected paths | Full plus owner acceptance under existing governance |
| Missing trusted changed paths | Full plus owner acceptance when the contract policy is enabled |
| Owner person | Existing explicit review/acceptance behavior |
| System revert or fix | Full |

Reduced gate execution currently uses the direct Actions runner. Legacy controller
routes retain full checks and their old run wire shape. Contract eligibility also
requires green main with no audit debt. The exact run
covers the declared contract, changed test files and the composed Intent contract
union. Lockfile, test infrastructure or other paths that require full selection
escalate to full. A full or docs pass satisfies either gate. Each acceptance still
checks the exact Candidate, current policy, main head and receipt; a contract from
another run is not passing evidence.

Eligible hosted automatic-accept landings group by default and run the full
shared gate, with no separate solo check required. `acceptance.landing: "serial"`
opts out: entries then check alone under this gate. Up to six groups pipeline on
the exact predicted predecessor head and receipt (`checks.concurrency` overrides).
Passing successors retain evidence and publish in order; a failed predecessor
invalidates its dependent stack. See [hosted grouping](operations/landing-batches.md#hosted-queue-priority).

When main moves under a passing full check and the clean recomposition cannot
reuse it, the retry may run a scoped recheck (`acceptance.scopedRecheck`, absent
means on; with `mode: auto-on-pass` under `gate: contract`, `gate: full` or no gate,
Issue fc215574). Eligibility is the contract gate's, apart
from the Intent contract: an eligible agent (see [actor eligibility](parallel-work-defaults.md#reduced-evidence-actors)), automatic acceptance, unprotected paths,
green main without audit debt. The planner runs the tests affected by both the main
delta since the checked base and this change, the change's own test files, the
composed Intent union and fixed smoke. Only this change's side can widen the run:
its unclassified or deleted paths, package or lockfile, root configuration or the
selector itself select the full suite. Such a path on main's side reaches every test,
so the intersection is this change's own affected set (the reason names main's
path). A docs-only side affects the tests that read its documents (`docsReaders`),
so a tested-doc overlap reruns those readers (Issue debe08fa). The skipped tests
become main-audit debt; a failed scoped recheck fails the landing as usual. The
receipt records `firstCheck: {"landedOn":"scoped-intersection","reason",
"selection","tests"}`. A configured check command gets the package intersection in
`FORGE_CHECK_PACKAGES` (packages this change touches, plus its dependents that
main's delta also reaches). A cohort's shared check is scoped the same way
when every member holds a full-pass basis (Issue 28f08555): the cohort's own
earlier whole pass when only main moved under it, otherwise each member's own.
Per basis, the planner rechecks the tests that can see both that checked change
and everything else in the cohort's Candidate (main's delta and the other
members), and runs their union with the members' own tests and smoke. A member
without a basis, or whose own side needs the full suite, keeps the full union.
Skipped tests are main-audit debt once per cohort head, and each member receipt
records `landedOn: "scoped-intersection"`. Set `scopedRecheck: false` to keep
full rechecks.

For a combined Candidate, every member must be eligible for the contract gate;
its check covers the union of their declared tests. One full-gated member makes
the combined check full.

Main may be briefly red after a contract-gated landing, or after a landing on
its [first check](pre-queue-checks.md#decision) (a change whose
admission run passed and which is path-disjoint from what main gained since).
The asynchronous main audit detects failures. A first-check landing arms it at
once instead of at the landing-count cadence; one audit run covers every landing
since the last green main, in place of the rechecks they skipped. Automatic
recovery never guesses and never loses code:

- It first re-runs only the failing test files on the failing head. If they pass it
  records a flake and changes nothing. Otherwise it bisects the coalesced range, re-running
  only those files (a single landing is the culprit with no bisect; at most
  `1 + ceil(log2(n+1))` probes for n landings) to a single proven culprit and reverts it
  with an ordinary landing (a reverse Candidate through the same queue, on current main,
  with a full check). Main never rewinds, history is never rewritten and later landings
  keep their bytes. The culprit's Intent is reopened with its Lane and work intact and
  carries one notice (shown in Needs you and in the agent's next read); the reverse
  receipt says why, names the re-land command (`nforge agent ROOT start
  '{"intentId":"…"}'` opens a Lane at the culprit's saved head) and how to undo.
- With several suspects, unclear evidence, or a reverse that conflicts, it
  reverts nothing and opens a fix-forward Intent.
- **Protected paths.** When the culprit's changed paths or the reverse's changed paths
  match the landing rule for the owner's agent (owner-approval or `acceptance.protectedPaths`,
  or path coverage is unavailable), the reverse is never auto-landed. It is prepared as a
  Candidate with no check and no landing; the culprit's Intent shows a Needs you notice naming
  the Candidate and the paths, and a person reviews, checks and accepts it.
- **`acceptance.autoRevert`.** Absent means on. `false` keeps the flake guard, stops
  before any bisect probe and opens only the fix-forward Intent; nothing is reverted.
  No preset sets it: `nforge x ROOT set-policy '{"operationId":"UUID","acceptance":{"autoRevert":false}}'`.
  Per red event it adds no Convex call beyond the existing recovery steps, and a green path
  costs nothing.

While main is red no change lands on its first check (recheck reason
`main-red`). A contract attempt ready during red main waits with `MAIN_RED` and
releases the queue without polling; readers show it as `Held: main is red` with
no queue position. Full-gated fixes continue. Green main
releases held attempts through the audit's event-driven wake. First-check and
rechecked landings carry the same receipt and CAS; the receipt's `firstCheck`
field says which path each took.

### Trust per path per actor

`autonomyPolicy.trust` is absent by default, which turns trust off. With
`trust: {"enabled": false}` Forge records the history but changes no gate (shadow
mode). The owner approves the thresholds before setting `enabled: true`. Read the
policy with `nforge agent ROOT policy` and change it with
`nforge x ROOT set-policy '{"trust":{"enabled":false}}'`; both work on hosted
projects. Enforcement applies only when `acceptance.gate` is `contract`. Omitted
fields take these defaults: `trustedAt` 25, `autonomousAt` 100, `halfLifeDays` 30,
`culpritKeep` 0.1, `probationLandings` 10.

- **Earned per path and actor.** Each accepted landing adds a weight to every area
  (directory, two levels deep) it changed: 1 without a contract, then 2, 3 and 4
  at 1, 3 and 7 or more contract tests. The score halves every `halfLifeDays` of
  idleness (computed when read; nothing runs on a timer).
- **Levels.** Below `trustedAt` an area is `supervised`, from `trustedAt`
  `trusted`, from `autonomousAt` `autonomous`. A Candidate takes the lowest level
  of the areas it changed; unknown paths are supervised. Enforcement only demotes
  the gate: a supervised area runs the full gate, and trust never grants a gate the
  acceptance policy withholds.
- **Lost on culprits, on that path only.** A culprit finding multiplies the score
  of the areas of the culprit landing by `culpritKeep`; other areas are unchanged
  (every area, if the culprit's paths are unknown).
- **New vendors.** An actor starts supervised everywhere and stays supervised
  until it has `probationLandings` green landings, unless its vendor is listed in
  `establishedVendors` (`vendors` maps an actor id to its vendor; an unlisted actor
  is its own vendor).
- **Delegation.** `decide` accepts `delegation: {actor, paths, level, until?}`;
  only the project owner may record it. The decision is the record; superseding it
  revokes the delegation. A delegation raises the level (`trusted` or
  `autonomous`) above the earned level or probation on the matching paths only; it
  never lowers one.
- **Shown** in agent briefs and by `projectHostedTrust:effective` (the caller's
  level for given paths). State is one bounded row per actor, updated on landing
  and culprit events: one read and one write per landing, nothing when idle.

The gate ships dark for existing projects. Deploy the server, runner, main audit
and automatic recovery before enabling it. With a drained queue and the current
main receipt fully checked, the owner enables it with
`nforge x ROOT set-policy '{"operationId":"UUID","acceptance":{"gate":"contract"}}'` (or
`nforge hosted-work DEPLOYMENT PROJECT_ID '{"action":"set-policy","operationId":"UUID","acceptance":{"gate":"contract"}}'`).
Use the same command with a fresh UUID and `gate: full` to revert the policy.
Gate changes invalidate older pinned attempts through `POLICY_CHANGED`. A
`protectedPaths` edit affects only Candidates matching an added or removed
pattern and Candidates without known changed paths. Add `"dryRun":true` to
`set-policy` to preview the impact before applying the edit.

An agent can request `tests` with `timingBasis: history`, then `confirm-tests`
with that basis, the exact Candidate/head and proposed contract version before
finishing. Hosted history uses the existing per-file timing estimates (EWMA),
with the most recent green main run as provenance. Missing historical timings or
a total of 90 seconds or more leave the full gate in effect; the full run can
supply exact measurements for a later declaration. History is an estimate, not
passing evidence for this Candidate. Old runners keep their existing full/docs selection, including composed Intent
unions; new runners send gate metadata only when the server stamped the run.

Current free-runner estimates are about 68 job-minutes for a full landing and
10–14 for a contract landing including amortized audits. The target is one fifth
of the same-runner full baseline. The old 10.17-minute baseline's 2.03-minute
target is unreachable with this workflow on free runners. The plan plus static
job also keeps the estimated finish-to-main floor near five minutes; this slice
claims no measured latency improvement. Idle gate work adds zero calls. Audits on
public repositories use free runner minutes; a private repository can exceed its
2,000 included minutes.

## Home and Settings

The signed-in Projects page combines hosted projects, GitHub imports, shared projects and shared source in one list. Yours, Shared with you, Starred and GitHub filter that list. Existing source bookmarks appear as stars and retain their saved source locations. Public project stars follow the signed-in account. Previous browser-only stars for public projects do not count as Forge stars. Private project bookmarks remain in the current browser and source bookmarks remain account-backed. Removed projects remain available below the list. GitHub analysis owners can use the row’s action menu → Remove. The confirmation names the repository and explains that removal affects everyone sharing the analysis, while GitHub is untouched. The analysis disappears immediately; bounded background cleanup removes its saved views, sharing, Zones, agent grants, interests and stored artifacts. Blobs retained by another analysis are preserved. Shared readers do not get a removal action.

Home includes projects owned by the account and current contributor/reader grants; shared projects show the account’s role. Reader discovery uses paginated `projectReaders.shared` grants and immediately reflects revocation and project removal. Deployments without this query continue to show owned and contributor projects; other query failures retain their normal error behavior.

Home and Settings share a centred 1120px page frame. Checks lists all recent seven-day runs and the latest main acceptance’s recorded checks in full, with all older definitions behind one disclosure. Historical one-off acceptance checks do not become current acceptance requirements. Commands use readable runtime names and repository-relative or home-relative paths; the original command remains in the hover text.

Project Settings uses a left navigation grouped into Project, Admin and You, with a page selector on mobile. General is the default. Autonomy edits the existing policy with a pinned prior policy and a retained operation ID for retry. Readers see policy and check values with “Only owners can change this”; owners retain policy controls and the check definition command. Protected paths appear as editable chips. Local Checks can define and edit commands; hosted Checks shows recorded definitions and outcomes. Access uses the existing owner/contributor APIs; it does not invent additional roles. General shows owner, visibility and creation date. Readers see these facts once in the table; owners also retain the project summary above their controls. Contributions and Transfer & backups retain the existing proposal and source handoff controls. Unsupported pages are omitted from navigation. Guidance, appearance, signed-in devices and existing lifecycle/backup controls stay available where supported.

## Reviewing a Candidate

Review starts with the Intent outcome and its recorded notes, followed by Lane saves in build order. Select a save cohort to inspect the Candidate’s final changes to the files touched by that save. Groups come from retained provenance; missing save authors remain unknown. The shared diff supports Unified, Split and Inline modes, viewed files and cached syntax highlighting.

Accepted and superseded Candidates show their retained disposition instead of decision controls; a superseded Candidate links to its replacement and check status. The check record identifies the exact Candidate and source head. Accept into main uses the existing Channel concurrency and autonomy policy checks. Ask for changes records feedback (a local Candidate review, or a hosted Intent decision naming the Candidate); it does not create a new acceptance requirement. Hand to an agent opens the review briefing sheet.

## Autonomy policy

`nforge policy ROOT` (also `nforge agent ROOT policy`) reads the typed `AutonomyPolicy` exported from the package. Local Work status and agent status include `autonomyPolicy`. MCP exposes them through `forge_work_overview` and `forge_task`. Hosted clients use `projectAutonomy.read` and `projectAutonomy.set`. On a hosted ROOT, `nforge agent ROOT policy` is one query and `nforge x ROOT set-policy` is one mutation (no capability call; the server enforces owner authority). Without an `operationId`, `set-policy` generates one and returns it; replay it with the same fields to reconcile an unknown outcome. `nforge hosted-work DEPLOYMENT PROJECT_ID '{"action":"policy"}'` and `forge_hosted_work` expose the same read/write commands without needing a Work index.

```sh
nforge set-policy ROOT '{"operationId":"UUID","preset":"trusted"}'
nforge x ROOT set-policy '{"operationId":"UUID","acceptance":{"protectedPaths":["convex/**","**/package-lock.json"]}}'
nforge hosted-work DEPLOYMENT PROJECT_ID '{"action":"set-policy","operationId":"UUID","preset":"supervised"}'
```

A built-in preset replaces all settings; selecting custom retains the current fields. A field edit merges only the supplied fields and changes `preset` to `custom`. An optional `expectedPolicy` guards a settings edit against a concurrent change. Retrying the original operation returns its original policy receipt without reverting later settings.

- `supervised`: acceptance `review`, Lane updates `ask`, completion and cleanup off, away summary on.
- `trusted`: acceptance `auto-on-pass`, Lane updates `auto`, completion on, cleanup off, away summary on.
- `autonomous`: trusted settings with cleanup on.
- `custom`: individually edited settings. Existing projects without a stored policy use trusted settings under this name, with cleanup off.

`acceptance.autoActors` contains local actor IDs or hosted accounts; hosted reads show those accounts to writers as Forge handles and omit them for public readers. Omitted/empty means all agents; it does not grant project authority. `FORGE_ACTOR` selects the local agent label (default: OS username). `acceptance.protectedPaths` contains case-sensitive, repository-relative globs (`*`, `**`, `?`, character classes and brace alternatives); additions, deletions, mode changes and both sides of a renamed path are covered. Matching changes always need a person. Automatic acceptance requires a recorded passing check for the exact Candidate ID and source head. It cannot roll main back or omit its current accepted head.

The native-owner settings `acceptance.disjointFastPath`, `ownerRootUpdates` and `laneUpdates` went
with the local landing driver (one client mode, Issue 657d63ee); stored values stay readable and
have no effect. On the hosted queue, [landing modes](pre-queue-checks.md#landing-modes) decide when
a change lands on its own check, and the main audit finds and reverts a proven culprit
(`acceptance.autoRevert`; see [hosted acceptance gate](#hosted-acceptance-gate)). See
[agent workflow](agents/workflow.md#disjoint-fast-path-landing) for receipts.

Hosted finish composes and checks against current main automatically, as a merge queue does. On overlap, hosted agents edit the returned sibling conflict Lane, call `resolve`, then run its returned `finish` command; see [hosted conflict recovery](operations/source-exchange.md#hosted-conflict-recovery).

`lifecycle.completeOnAccept` controls completion of local accepted input Lanes and their Intent (when all its Lanes are complete); `keepOpen:true` leaves them open. On a hosted project, landing also completes the landed Lanes' Intent by default even when the Lane stays open, so the Issue closes (when its Done-when lines are ticked) without a hand-close; with lines still open the next planning read holds it open (no auto-close) and names the open lines and the close command; `closes:false` (also keeps the Lanes open, like `keepOpen`) or policy `lifecycle.closeOnLand:"off"` makes a landing refs-only (see [workflow](agents/workflow.md)). Undo completion with `reopen`. The existing `lifecycle.cleanRegenerableCopies` switch enables automatic `lanes`, `lane-deps`, `check-workspaces`, `check-retention` and `exchange-staging` cleanup after local Lane completion or abandonment and accepted-work completion. Acceptance also sweeps eligible closed copies left from earlier work. Only Autonomous enables this switch by default. `completeOnAccept` is on for every preset of a new project; migrated projects keep their stored value. Completion and cleanup have retry-safe action receipts; replay does not complete or remove a subsequently reopened active Lane. An automatic cleanup with eligible items records removed paths, skipped items and reasons, and restore instructions. An empty sweep returns its skipped reasons without recording an action or advancing Work. Completed or abandoned Lane folders are removed only when their source equals the retained head, no source operation is pending, and no local process is working there. Active, dirty, in-use and unverifiable copies stay. Automatic whole-Lane cleanup also retains excluded local settings and arbitrary ignored files outside recognized regenerable build directories. Source States, Lane records, saves, history, result receipts, log tails, artifacts and reachable objects are retained. The owner-approved seven-day policy removes eligible unpinned old check source/shard copies and bulky log prefixes, and unreferenced old exchange staging; see [local cleanup](operations.md#local-cleanup). Run `reopen` with the Lane id to re-materialize its head; restore dependencies with `npm ci --ignore-scripts` and the project's build.

A hosted project owner can pin a Lane with `nforge x ROOT pin '{"laneId":"LANE_ID"}'` (`"pinned":false` unpins; `laneId` is filled from inside a Lane directory). A pinned Lane is skipped by complete-merged, `completeOnAccept`, the Intent cascade, `nforge prune` and client cache GC, and an explicit `complete` or `abandon` refuses it with `LANE_PINNED` until it is unpinned. Reopen still works, and any Lane state can be pinned.

`notify.awaySummary` is a preference exposed for the separately implemented cockpit; it starts no notification transport.

Hosted policy is independent of uploaded local policy. Source exchange/return preserves hosted Channel receipts and cannot change hosted policy. A person can select a clean Candidate without a prior local acceptance receipt (`acceptanceId` is optional). A person may explicitly select an earlier retained local acceptance for rollback; automatic acceptance cannot. Native object checkpoints support source-byte path/ancestry validation; legacy archives/Git checkpoints retain local Candidate/acceptance provenance, and unavailable protected-path coverage requires a person. Hosted check records remain reports from the local execution owner, not independently verified execution.

New hosted projects, including GitHub imports, receive the supervised preset.

## Checks

In hosted Review, select a check and a connected computer you own, then request the run. Other people's runners are disabled. Current project owners and contributors may queue on their own runners; the project owner cannot queue on a contributor's runner. To check a contributor's proposal on the owner's computer, the runner owner queues it. The requester, runner owner or project owner can cancel or update a request while they retain project write access. Revoked contributors cannot act on retained requests. Retries keep the original operation UUID and pins. The canonical owner's **Re-check on latest main** path remains project-owner-only.

Checks run the exact Candidate in a fresh workspace with a **clean environment**, including private HOME, XDG and temporary directories. Playbooks and automations use the same runner. Existing definitions need no migration and receive the clean defaults. Node/npm tools remain available through PATH, and npm, Go, Cargo, Gradle, Maven, pip, uv and NuGet use dedicated credential-free content caches outside HOME, one per project, so cached dependencies can be installed offline. Installed rustup, pyenv, mise and asdf toolchains in their default locations stay usable ([details](operations/self-hosted-runner.md#toolchains-and-caches-in-checks)). The standard `scripts/forge-check.mjs` installs locked dependencies and runs verification using that cache.

Use per-check declarations for required parent settings:

```sh
nforge x ROOT configure-check '{"command":{"name":"integration","executable":"node","args":["tests/integration.mjs"],"env":["SERVICE_URL"],"credentials":["SERVICE_TOKEN"],"environmentLabel":"clean"}}'
```

`env` and `credentials` contain environment variable names, never values. Both are explicit passthrough; the latter identifies credentials separately. They change the definition digest and appear in check definitions and receipts. They do not inject Secret Objects. Omitted variables are absent; failed runs suggest omitted names that may need passthrough. Values are not retained by the runner, but commands can print them into logs. See [secrets for checks](security.md#secrets-for-checks) for the runner store versus the planned sealed Checks set, and [clean check environments](security.md#clean-check-environments) for the complete allowlist and filesystem limitations. A clean environment is not an OS sandbox.

### Check command scope

Forge's own recipe (`node scripts/forge-check.mjs`) selects and shards test files itself. Any other
configured command (`x configure-check {command}`) runs in full, in one job, unless
its check declares more. Either way it receives the changed paths:

- `FORGE_CHECK_CHANGES`: path of a JSON file outside the checkout, removed after the command:
  `{"version":1,"comparison":"main","base":STATE,"head":STATE,"paths":[…],"mode":"full"|"scoped"}`.
  `base` is the main the Candidate composed on and `head` the exact Candidate (`FORGE_CHECK_BASE`,
  `FORGE_CHECK_HEAD`); `paths` lists every added, modified, deleted or mode-changed path, sorted. A scoped
  run may add `tests` (Intent contract or probe test files the command must run) and, for a scoped
  recheck after main moved, `mainPaths` (what main gained since the checked base). A scoped cohort
  recheck instead adds `members: [{paths, mainPaths}]`, per member basis its checked change and what
  else differs in the cohort's Candidate. `paths` is absent when the list is over 128 KiB; `mode` is
  then `full`.
- `mode: "full"` (also `FORGE_CHECK_FULL=1`) means run everything. `mode: "scoped"`
  (`FORGE_CHECK_SCOPED=1`) means the command may run only what the change affects.
- `FORGE_CHECK_PACKAGES` (hosted Actions, scoped runs only): path of a JSON file outside the checkout
  with the manifest package graph's view of the change, read from the Candidate's manifests without
  running its code: `{"version":1,"scope":"scoped"|"none"|"full"|"docs","reason":…,"packages":[{ecosystem,dir,name,why}],"commands":[{ecosystem,cwd,argv}]}`
  (the changed packages and every package that depends on them, with each ecosystem's own test
  command; see [package graph](parallel-work-defaults.md#preflight)). `scope: "full"` gives the reason
  the graph could not place the change; the command then runs everything. A command may run
  `commands` as given or use `packages` with its own tool. On a scoped main-race recheck the file holds the
  package intersection: the packages this change touches, plus those of its dependents that
  main's delta since the checked base also reaches (`src/package-intersection.ts`); on a scoped
  cohort recheck, the union of each member's intersection.
- `FORGE_CHECK_PACKAGES_RUN` (same runs, only when the graph selected packages with tests): an
  executable that runs those `commands` in the checkout, in order, without a shell, with the calling
  script's environment, and exits with the first failure's code (Forge's
  `scripts/check-packages-run.mjs`). A repository's own CI script opts in with one line at its test
  step, after its setup (toolchains, fetched test data, `uv sync`):

  ```sh
  [ -z "${FORGE_CHECK_PACKAGES_RUN:-}" ] || exec "$FORGE_CHECK_PACKAGES_RUN"
  ```

  Without the variable (a full run, or a change the graph cannot place) the script goes on with its
  full steps; steps before the line (lint, build) still run every time.

  Both files sit in a fresh folder in the job's temp folder (`$RUNNER_TEMP/forge-packages-…`),
  owned by the supervisor (folder `0711`, list `0644`, runner `0755`) and handed to the
  [Candidate user](operations/github-actions-checks.md#what-actions-evidence-attests) read-only:
  it reads the list and runs the runner but cannot change either, and Forge removes the folder
  after the command.

Declare the contract with `selection` in the check definition; it changes the definition digest:

```sh
nforge x ROOT configure-check '{"command":{"name":"ci","executable":"bash","args":["ci/check.sh"],"selection":{"scope":"changed-paths","shards":4},"environmentLabel":"clean"}}'
```

- `"scope":"changed-paths"`: the command reads the file and may scope. Forge sets `mode: "scoped"` only
  where its own check may scope (a contract, probe or scoped-recheck gate) or on a package-graph first
  check (below); no gate, a full gate and the post-accept main audit always get `mode: "full"`. A scoped run is **scoped evidence**: it lands on the
  contract gate's terms and leaves main-audit debt, never full evidence, whatever the command then does.
  A command may write `{"scope":"full"|"scoped",…}` to `FORGE_CHECK_SELECTION`; on hosted Actions a
  passing command that reports a reduced scope when asked for `full` fails with `SCOPE_MISMATCH`.
- `"shards":N` (2 to 20): hosted Actions runs N test jobs plus one static job, capped by the runner's
  concurrency budget, the per-check Convex call budget and free job slots. Test jobs get
  `FORGE_CHECK_PART=tests` and `FORGE_CHECK_SHARD=i/N` (1-based, also `FORGE_CHECK_SHARD_INDEX` and
  `FORGE_CHECK_SHARD_TOTAL`), the form `vitest --shard` and `jest --shard` take; the static job gets
  `FORGE_CHECK_PART=static` for lint, types or build. The job passes only when every part passes, so
  the command must cover everything across its parts.

**Package-graph first check.** An Intent without a contract normally gets a full first check. For a
declared `changed-paths` command on hosted Actions, the server instead stamps the `graph-first` gate
when every other contract-gate guard holds (contract gate on, auto-on-pass, an eligible agent,
unprotected known paths, trust, green debt-free main). The planner then reads the Candidate's
manifests, `forge.json` and the check's own scripts (never runs its code) and asks for `mode: "scoped"`
only when the graph places every changed path, selects at most 50% of the testable packages and every
selected ecosystem's test flags can be kept (the same flags the runner applies); a root package, an
unplaced path, an unknown graph, flags Forge cannot place, nothing to run or a majority keep the run
full (fallback `graph-full`). The run then carries `fallbackReason`, the selection's reason text (at
most 300 characters, naming what to declare: `packages.commands`, `packages.edges`), shown by
`status {runId}` (and as `selection.ranInFull` with `summary:true`) and on the landing's `wait` line as
`ranInFull`. A package
only cross-ecosystem widening pulled in (no `packages.edges`) is named as "widened in, not changed",
with `packages.edges` offered before its own command. The share is recorded on the
run (`selection.graph: {scope, selected, total, reason}`), and the server refuses a scoped plan
without a minority share. A scoped pass is scoped evidence: it is accepted on the contract gate's terms
re-read at acceptance (red main holds it), leaves main-audit debt and is covered by the full
post-accept main audit. It adds no check run and no Convex call. Forge's own recipe keeps full first
checks (Issue 5562167f): its graph is one root package, so it would always select everything.

`check-settings` lists a `proposals` entry, and `configure-check` returns a `proposal`, for every
configured command that declares no scope: it runs in full on every check, so the package graph never
saves a minute. The proposal is the `selection` to add and the one line above.

A check without `selection` keeps today's behaviour: one full job. Local and self-hosted machine runners
already supply the same file to every command and run it as one job.

Choose the project's runner once with `nforge agent ROOT configure-runner` (owner only); see
[GitHub Actions checks](operations/github-actions-checks.md). Each terminal receipt records
`backend.cost` with billed quantities, estimated USD and its basis; see
[runner selection and cost basis](operations.md#runner-selection) for label rates and allowance
exclusions. Queued code candidates land through the [hosted landing queue](agents/workflow.md#landing-queue).

Shared check evidence retains named test verdicts and quarantines. Two supported
flake verdicts within seven days quarantine the exact test; it continues running.
Twenty consecutive clean passes or an explicit fix release quarantine. Actions
retains each attempt and retries unfinished infrastructure jobs, not test failures.

### Local preflight guards

`nforge agent ROOT preflight` runs a project's declared **guards** first, in declared order, and its 180 s test budget never cuts or stops them: once the wall clock is spent, every remaining guard still starts and only the other files stop. A guard is a cheap, broad test that catches a class of mistake the import graph cannot see. It is declared once as `preflight.guards` in a root `forge.json` (any language), or as `forge.preflight.guards` in `package.json`: `{name, tests: [path, ...], inputs?: [glob, ...]}`. A guard runs when the change touches its `inputs` (no `inputs`: every change), joins the protected mandatory tier, and is shown in the plan with its cost (`local.guards`, seconds measured on this machine where known). A guard naming a test the project lacks makes the plan unavailable instead of silently skipping. Static checks (`preflight.static`) run before any build or test and also on `land --save` when tests are advised or deferred, including over-budget plans. Static failures that are the change's own (in a file it adds, edits or renames into, or new compared with a local copy of its base) refuse before submission; a failure already on main, or only on Forge's own Lane metadata (`.forge/`), is a one-line advisory and never refuses. The receipt and land reply name each check and outcome separately from the test status. Entries may declare a `fix` command to include in a failure; otherwise Forge names the command to rerun after fixing the reported files. A static-only receipt does not claim test coverage. A guard is for tests that need the build.

This project declares these:

| Guard | Test | Runs when the change touches | Cost |
| --- | --- | --- | --- |
| agent weight | `tests/perf-harness.test.mjs`: the exact counts package smoke enforces on the installed archive (modules of `--version`, `--help`, the MCP listing and each agent command, MCP tool-list bytes, agent actions and runtime dependencies), measured on the Lane's build. CPU ceilings stay with the landing check: a local CPU number is not comparable with the runner's. Installed bytes need the packed archive and also stay there | `src/**`, `scripts/perf/**`, every `scripts/*.mjs` the built code imports (a test keeps this list complete), the agent-weight and bundle build scripts, `tsconfig.json`, the weight baseline, `package.json`, `package-lock.json` (never a docs- or test-only Lane) | about 6 s |
| landing exact I/O | `tests/landing-cost-guard.test.mjs`, `tests/hosted-early-resolution-speed.test.mjs`, `tests/hosted-landing-admission-default.test.mjs`, `tests/hosted-landing-cohort-isolation.test.mjs`, `tests/hosted-precompose-ownership.test.mjs`, `tests/hosted-acceptance-scale.test.mjs` (they pin the landing's calls, reads and writes; a landing replay test with a `Reads N -> M` step history must be one of them) | the landing transaction (`convex/projectHosted*.ts`, `convex/projectLanding*.ts`, `convex/schema.ts`), the ledgers they read (`src/speed-budgets.json`, `src/cost-budgets.ts`) and their replay fixtures | about 45 s |
| account device registrations | `tests/account-registration.test.mjs` | `convex/**`, its Convex module loader | about 20 s |
| convex runtime imports | `tests/convex-runtime-imports.test.mjs` | `src/**`, `convex/**`, `scripts/check-convex-*.mjs`, `package.json` | about 28 s |
| hot storage invariant | `tests/hot-storage-invariant.test.mjs` | `convex/**` | about 1 s |
| agent response contract | `tests/hosted-response-contract.test.mjs`, `tests/hosted-agent-help.test.mjs` (help and docs generated from the schemas) | hosted contract and response sources, `scripts/response-compat*` (release and main baselines), `convex/projectHostedAgent*.ts` | about 2 s |
| agent parent simulation | `tests/agent-parent-simulated.test.mjs` | the agent session, client process, wake and slug sources and their tests | about 5 s |
| cleanup process coverage | `tests/clean-processes.test.mjs` | the process cleanup and prune sources and their fixtures | about 4 s |

**Learned guard set.** Preflight also runs a learned set of guards first, whatever changed, for every project and runner: test files that keep failing landing checks while preflight skipped them (repo-wide schema, boundary, browser and help-text tests the import graph never selects). It is an Automatic setting, learned from the whole project on the server, so a fresh sandbox or CI runner gets it on its first Lane start. Each land gate says which test files that head's preflight ran (4 characters per file, up to 256 files) and how many local preflight runs the Lane had. When a landing check fails, the server records the failing test files that preflight did not run, in one bounded per-project record (the last 50 failures, at most 4 KB). A file main's own red audit fails is main's failure, never the Lane's: it is not recorded, and while main fails something it does not name (more files than it lists, or a static job) the failure teaches no file. When an audit turns main red, the failures recorded since its first unaudited landing stop naming its failing files. When main recovers, the audit row keeps the last red head and its failing tests so checks already pinned to that head still exclude those files when their verdict arrives. Nothing is written for a landing that passes. A Lane start's reply carries the candidates when they changed since the revision the CLI holds, and so does the capability read of `open`, `preflight` and `land` when this machine's copy is over an hour old. The CLI keeps one copy per project on the machine (under `$XDG_STATE_HOME/forge/preflight-guards/`, else `~/.local/state/`), so every checkout of the project uses it, and planning makes no call. For each file, the saving per preflight is `p x C / r - t`:

- `p` is the share of the last 50 landing outcomes where the file failed the check while preflight skipped it.
- `C` is the median builder wait (submission to check verdict) of the failed landings in that window.
- `r` is local preflight runs per landing, averaged over the failed landings in that window that reported it (at least 1).
- `t` is the file's seconds, measured on this machine, else in the check, else the per-file estimate.

The window counts landed outcomes from the landing-speed record the server already keeps (its last 40 landings), and stops at the oldest one it holds. A landing whose gate did not say what ran (an older CLI, a preflight of more than 256 files, or a multi-Lane landing with an ungated Lane) still counts as a failed outcome, but teaches no file.

A file joins when the saving is positive and it failed at least twice, and leaves when either stops holding. Files join in order of saving until their seconds would pass the run's local budget, so guards count inside the 180 s budget and the 600 s ceiling. Runner minutes a catch saves are an extra the formula does not count. The plan names each file in `local.guardSet` with `p`, `C`, `r`, `t` and the saving. The summary line says why each one is in, and `local.guardSet.setting` declares the signal, formula, bounds and override. Learned guards join `local.guards` as `learned guard set` and are never trimmed, stopped or reused across saves. A project with no check failures, or a machine the set has not reached yet, has an empty set, so nothing changes. Override it in `forge.json` as `preflight.guardSet` (or `forge.preflight.guardSet` in `package.json`): `{"mode": "automatic" | "manual" | "off", "pin": [test], "unpin": [test]}`. `pin` always runs a file. `unpin` never learns one. `manual` runs only the pinned files and names what Automatic would pick, and `off` runs none. A malformed value, or a pin the project lacks, makes the plan unavailable. `FORGE_PREFLIGHT_GUARD_SET=automatic|manual|off` sets the mode for one environment over `forge.json`; the bench sets `off` for comparison cells, since they share one project and must never depend on cell order. The setting is judged on the shared flow measure (landings that stay landed, save-to-main time), not on its own catch count.

The preflight timing experiment is off by default. With `FORGE_PREFLIGHT_TIME_SETTINGS=1`, a
project can set `preflight.budgetSeconds` and `preflight.ceilingSeconds` in the same project
configuration. An omitted setting uses 180 s for the budget and 600 s for the ceiling. A per-run
`budgetSeconds` takes priority for that run and raises its ceiling if needed. Preflight checks the
ceiling before starting the next group of test files or package command. Package commands use
only the ceiling. The preflight plan and run receipt show the source of each time setting.

The hosted check stays the full run. See [parallel work defaults](parallel-work-defaults.md#preflight) for the rest of the selection rule.

## Channels and releases

Post-accept main audits retain one covering-run selection on the audited acceptance. Status, making-of and accounting derive the covering run for earlier requests in that Channel; a new audit does not rewrite those earlier acceptance records. Legacy per-request pointers remain readable.

A Channel is a named pointer to accepted source. Accept a clean Candidate with the expected previous head. A person can explicitly select an earlier accepted Candidate to roll back. Automatic acceptance cannot rewind a Channel.

Local acceptance uses a **landing queue**: a crash-safe FIFO slot per owner and Channel, shared by finish and person acceptance through CLI/MCP. Initial Lane checks and check-only work remain parallel under the machine check queue. When main moves during a finish check, finish releases the slot for the retry's sync → compose → fresh exact-Candidate check, then rejoins only for acceptance with expected-head CAS. `finish.maxRetries` defaults to three retries after the initial attempt; waiting costs no attempts. Receipts retain all attempt pins/child IDs and observed queue positions (`waiting to land`). Conflicts, failed checks, policy-required review and exhausted retries stop explicitly. See [agent workflow](agents/workflow.md#landing-queue) for replay and bounded observation.

Supervised projects still require a person. If main moves before a person's acceptance, it returns `CHANNEL_CHANGED` (or `CHANNEL_DIVERGED` for a Candidate missing current main) with “main moved; re-check needed”. Sync and check a new Candidate, then review and accept that Candidate; no prior approval is carried forward. Explicit person rollback to an earlier accepted Candidate remains available. This queue coordinates local writers on the same owner; upgrade all those writers. Hosted Channel selection retains its hosted authority/concurrency rules.

## Hosted project and companion

A hosted project stores source and Work records and its own journal of Intents, notes and Channel selections. `nforge host` seeds it once; after that agents start, save and land hosted Lanes. Source and artifact bytes live in R2 ([data placement](data-placement.md)); Convex holds records. Agents edit local Lane checkouts, and checks run on the runner the project's policy selects.

```sh
nforge login https://DEPLOYMENT.convex.cloud
nforge host ROOT                         # any directory or Git worktree; private by default
nforge host ROOT --status
nforge hosted-work ROOT '{"action":"workspace"}'
nforge coordination ROOT '{"action":"sessions"}'
nforge exchange ROOT pull --target NEW_DIR   # check out hosted main; without --target: ROOT-hosted-main beside ROOT
```

`host` bootstraps a plain directory as Forge-native source without Git, creates the
project, sends only missing source/Work objects and starts hosted Work without a
full index rebuild. Capture preserves file bytes, empty and binary files, and
executable modes under the normal ignore rules. New native hosts atomically select
server authority and verified hosted main when seeding finishes. Clone the printed
project URL to start Lanes; existing hosted projects retain their authority.
The project URL and next steps are printed together. No archive upload, copied IDs,
command file or browser initialization is needed. `--deployment URL` selects a backend; otherwise
Forge uses the saved login deployment (or `FORGE_DEPLOYMENT_URL`). `--name NAME` changes the hosted
name and `--visibility private|public` selects visibility. Public projects permit signed-in read
access; changing Work still needs owner/contributor authority. New hosted projects use H6’s `supervised` autonomy policy; owners can inspect it with
`nforge agent ROOT policy` (or `nforge hosted-work ROOT '{"action":"policy"}'`). Hosting needs a device login with
`cli` scope; a coordination-only login cannot create or upload projects.

The owner records its deployment and project ID privately alongside Work. Re-running an interrupted
`host` resumes the original UUIDs and pinned snapshot, including after a lost reply;
objects already stored are reused. `--status` reports the binding and any pending hosting operation.
Hosting a completed binding again is refused; `--new` explicitly creates and selects another project.
Re-running an interrupted `--new` resumes it. The previous binding stays usable while the new host
is pending, and unfinished hosting operations keep their original per-project pins (shown by `--status`).
Completing an older hosting operation cannot overwrite a newer binding. Local source, Lanes and Work revisions are unchanged.
Git-backed owners preserve Git history and Work and transfer their source bundle via the same
missing-object/chunk exchange; no compressed Work archive is generated or uploaded.

Native hosting transfers the pinned bootstrap/current accepted `main`, retained
source and complete Work metadata through finite pages. Completion validates the
retained content pins before selecting the checkpoint and hosted main; there is
no first-host background backfill. Original operation IDs and capture pins survive
an interruption. Older pending seeds keep their original authority and require
the existing cutover path to change it.

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
`convex/indexer.ts`, where public and private analysis both run in a Convex Node action. Private
source and tokens stay on that authenticated path. Credentials stay in the existing hosted integration, never CLI arguments or progress.

Those paths currently produce a selected source/analysis artifact, not a full Git history bundle
plus Forge Work. Connecting them directly would silently omit local-only commits, refs, Work,
logs and artifacts. Extend the importer to write project-scoped exchange objects and the exact
retained Git closure, reporting the same progress/completion pins. Upload only local-only source
and Work through the client exchange, then verify the union against the local manifest before
binding the owner. Preserve operation receipts on lost replies, and fail explicitly on changed
repository/head/access; do not silently switch to uploading everything. Test public/private
access revocation, inaccessible commits, local-only history and interrupted import recovery before
exposing the flag. Ordinary `host` remains the implemented path.

Bound pull checks out the selected hosted `main` into a new client directory. Without `--target`,
the sibling name is `ROOT-hosted-main`. The original owner remains intact. `exchange ROOT push` is
refused with `CLI_UPGRADE_REQUIRED`: there is no push path any more (see
[source exchange](operations/source-exchange.md)). Commands with explicit deployment/project IDs and
request files remain supported.

In the browser you can create Intents and notes against hosted source. Review a Candidate and
accept it through the hosted landing queue, including while all owner machines are offline.
Request changes records feedback in Work and the Lane conversation; revert submits a reverse
Candidate through the same queue. CLI and MCP `land --save` (`finish`) use that queue too. Local clients edit
and save hosted Lanes; they do not reconcile a separate owner's metadata before acceptance.

## Contributor proposals

Project members with write access contribute through hosted clones and Lanes,
checks and landing. Stored contributor proposals retain their source, original
actor and supplied check claims; those claims are provenance, not owner check evidence.
A proposal is visible to everyone who can read the project and moves no Channel.

For a stored object proposal, download its receive request and run
`nforge exchange ROOT receive-proposal --command-file forge-proposal-receive.json`
in an independent recovery owner. The command validates source closure and creates
a separate Lane. Older stored archive proposals retain their Download proposal
path for their recorded source and Work. Current hosted edits go through hosted
Lanes rather than native export and source return. Public projects retain
[owner approval for protected paths](operations/governance.md), including when
a contributor selects person authority.

## GitHub

### GitHub sync MVP

Native `main` can keep an existing GitHub branch current even when native and Git history are unrelated:

```sh
nforge github-sync ROOT --repo OWNER/NAME --dry-run
nforge github-sync ROOT --repo OWNER/NAME --push
# Subsequent runs use the stored repo/branch binding:
nforge github-sync ROOT --dry-run
```

The default is `--dry-run`: it reads the remote and prints JSON with the target ref, commit messages, attribution, State/acceptance/Candidate ids and changed files per commit. It pushes nothing and does not change Work metadata. `--branch` defaults to `main`; it selects the GitHub destination, while the source is always accepted native `main`. Pass `--repo` on first use for native owners outside a Git checkout; otherwise Forge can use `gh repo view` to resolve it.

The first push records the repository, branch, adopted commit and State → Git commit mappings in Work. It creates one `Adopt Forge native main <state>` commit with the accepted tree and current GitHub head as parent. Later pushes follow native `main` acceptance order. Unchanged States or identical exported trees get no empty commit: dry-run lists them under `skipped`, and push advances the binding's `cursor`. Each commit keeps the accepted tree, supplied landing message (or Intent outcome), acceptance/Candidate ids and previous synced parent. Only accepted capture membership enters the tree, including retained tracked files that match capture heuristics; unaccepted edits and capture-excluded files do not.

Incremental commits use H8's accepting actor name when recorded and the configured Git email; older acceptances use the configured Git identity. Agent contributors/acceptors receive `Co-authored-by` trailers (local attribution is a declaration, not verified GitHub identity) at the vendor noreply address the hosted mirror uses (`noreply@anthropic.com` for Claude, `noreply@openai.com` for Codex/OpenAI/GPT, otherwise `forge@localhost`). A repository's lead co-author convention can be supplied through `FORGE_GITHUB_SYNC_COAUTHOR` or Git config `forge.githubSync.coAuthor`, in `Name <email>` form. For this MVP, configure `user.name`/`user.email` (or the sync identity below) and use your existing Git credential helper or `gh auth` login. Phase 3 will use the Forge GitHub App.

**Empty repositories.** If the destination branch does not exist (an empty repository or a new branch), the first push writes the `Adopt Forge native main <state>` commit as a root commit with no parent. The branch is created with an exact "must not exist" lease; if someone creates it first, Forge reports **GitHub changed outside Forge** and overwrites nothing. The binding records an empty adopted commit; later acceptances fast-forward from the root commit as usual.

**Rebinding.** Without `--rebind`, a bound owner refuses another repository or branch. To move the owner to a new destination:

```sh
nforge github-sync ROOT --repo OWNER/NAME [--branch B] --rebind            # dry-run: shows what would change, writes nothing
nforge github-sync ROOT --repo OWNER/NAME [--branch B] --rebind --push
```

`--rebind` requires `--repo` and replaces the stored binding with a fresh one (adopting the current accepted `main` into the new destination). It refuses with `GITHUB_SYNC_PENDING` while the current binding has an unfinished operation; reconcile that first. The replaced binding, with its State to commit mappings, is kept in Work metadata as `githubSyncHistory`. The automatic mirror policy is not changed: if it still points at the old repository, the output says so, and you update it separately with `set-policy`.

**Sync identity.** Sync commits (author and committer) use `FORGE_GITHUB_SYNC_NAME` / `FORGE_GITHUB_SYNC_EMAIL`, then Git config `forge.githubSync.name` / `forge.githubSync.email`, then `user.name` / `user.email`, each resolved independently. This keeps a personal address out of public history without changing your global Git identity, for manual sync and the automatic mirror alike (for example `git config --global forge.githubSync.email ID+USER@users.noreply.github.com`). Where an accepting actor name is recorded it is still the author name; only the email source changes.

A push only fast-forwards the exact observed GitHub commit. An exact ref lease protects the check/push race; ancestry is checked before sending. Branch protection/Actions remain GitHub's decision; the MVP does not open or merge PRs.

**Merges on GitHub.** Sync adopts external history only when a three-way check leaves accepted Forge bytes and modes unchanged. Squash merges, merge commits and empty changes use the same check. [Containment and adoption](architecture.md#github-containment-and-adoption) describes historical bases and dry-run proofs. A passing check proposes an adoption commit with current GitHub as parent; earlier mappings and history remain intact. Only `--push` changes Work metadata.

If merging an external path would change the export or conflict, sync refuses with `GITHUB_SYNC_CHANGED`, listing the external commit IDs and only the blocking paths, with a reason for each (`missingPathReasons` in structured diagnostics). Create a contribution Lane with `nforge agent ROOT start '{"outcome":"Import external GitHub changes"}'`. In a local GitHub checkout, inspect `git diff --binary RECORDED_COMMIT GITHUB_HEAD --` using the recorded and observed heads from the refusal. Reconcile only the missing external changes in that Lane with current main, preserving later Forge edits; review and accept the change, then retry `github-sync --push`. The original external commits remain on GitHub; this Lane brings their source changes into Forge. If GitHub rewrote history (its head no longer descends from the recorded commit), sync refuses even when the trees match. Dry-run reports these refusals with the same diagnostics. Neither case drops external work or force-pushes over it.

Pending commit identities and an operation UUID are saved before sending. After a lost reply, rerun `--push`: Forge reconciles an already-pushed batch through its saved mapping before preparing later acceptances. Optional `--operation-id UUID` replays a selected original batch, including after later syncs; retain the UUID printed in the plan/receipt. A failed push retains its original pending batch. Automatic publication is off unless enabled by the project policy below.

### Automatic main mirror

Settings → GitHub mirror uses the same one-sentence status as `nforge github status`.
At import, **Keep GitHub in sync both ways** starts ticked; unticking selects
Forge-to-GitHub only. GitHub approval connects that choice after import.

**Push cadence** defaults to **Automatic**. After a quiet period the next landing
pushes immediately. During a burst, one scheduled wake pushes the newest held
State in one fast-forward. Each State keeps its own commit. Automatic and
**Batch quick landings** use the median wall time of the last 20 recorded full
checks, clamped to one through ten minutes. Until a full check reports a wall
time, the window is zero. **Every landing** sets the burst window to zero.
All modes flush a revert immediately. A known red main holds a push until
recovery or 15 minutes from the first held landing. `mirror.pushNowPaths` is a
list of repository-relative globs that flush a regular burst on matching
changes. It keeps the red-main hold.

`nforge agent ROOT check-settings` reports the mode, observed median, sample
count, bounds and effective window. To change the cadence, edit `githubMirror.push`
in the existing `nforge x ROOT set-policy` owner command. `nforge github status`
and agent status show a held burst
and its deadline. `nforge agent ROOT landings '{"receiptId":"RECEIPT"}'` shows
whether that State is still held or reached GitHub and whether it was the pushed
tip.

Each pushed tip gets a GitHub `forge/verify` status linking to the Forge landing
receipt. Exact proof gives success, an own-check landing waits for audit coverage,
and a failed audit or a push at the red hold cap reports failure. The repository
can run its own on-push CI in every mode. A GitHub App installation needs
**Commit statuses: Write** for this status. A missing grant appears in mirror
status while source publication continues.

The owner person can **Pause** the mirror, keeping the repository binding,
recorded history and direction, then **Resume** it later. Pause sets
`githubMirror.autoPush:false` and `inbound:false`, keeping that policy readable by
existing CLIs; the project retains its chosen direction. Un-pausing restores that
direction and, in the same policy mutation, wakes a retained job and queues one
catch-up job for the current accepted main if GitHub is behind. The retained job
keeps its cursor and runs first. No further landing is needed. An un-pause that
also names another repository re-points the mirror and queues current main for
the new repository in the same edit, with no recovery command afterwards.

**Paused landings remain separate in Forge. Their combined source changes reach
GitHub in one catch-up commit**, naming each covered landing's subject and short
receipt id (the first 20, then “...and K more”), with the latest main's Forge
trailers. It never adds actor ids. The paused window does not become one GitHub
commit per landing. Only a publish that skips landings reads this history: one
mapping-receipt lookup and at most 21 rows by sequence. Normal adjacent publishes
add **zero reads**; the commit message is pinned before any GitHub write.
The normal non-forced fast-forward check still applies. A push already sent to
GitHub may finish while paused; later steps check the policy before continuing.
Un-pausing fences a pending or in-progress old worker before continuing its saved
cursor, so a late failure cannot stop the replacement.

**Disconnect** asks once, naming the repository and what stops, then clears the
matching mirror policy and stored binding atomically. It withdraws the
repository's runner grant for the owner's projects. A preconfigured mirror
without a stored binding can also be disconnected: the request pins the displayed
repository and ends its mirror policy. Operator-configured access stays in place,
so its owner can turn the mirror on again without another GitHub approval. A
stored link needs GitHub approval to reconnect. GitHub source/history, Forge
source, Lanes and mirror history stay.

Pause, un-pause and Disconnect require the owner person. `nforge github disconnect`
prints Settings → GitHub mirror guidance and changes nothing. An owner CLI device
can still run `nforge github resume` to recover an **already-enabled** mirror or
queue its missing catch-up; that command cannot un-pause a disabled policy.
Contributors and scoped agent grants cannot change these settings or recover an
owner's job.

Mirrors switched off before Pause existed still show **Turn the mirror on**. Resume
keeps their previous direction: the read uses the stored policy or the most recent
recorded enabled direction for the same repository, selected by index even after
unrelated policy edits. It never scans the whole policy history.

The screen has one bounded read subscription: selected mirror metadata plus one
indexed binding lookup for the owner's Disconnect control. A legacy off mirror
without its saved direction adds one selected policy-history row. Idle adds no
calls. Catch-up adds selected main/receipt/job metadata only to explicit recovery;
normal landing calls, source placement and per-landing cost are unchanged.

While the mirror is on for a server-authority project, each hosted main publication queues one mirror
job in the same transaction. The fixed Convex action uses the installed GitHub
App and Git Data API. It reads exact hosted/R2 source, creates only changed
blobs in windows of at most 100 and 8 MiB (or one larger file), then creates a
tree with `base_tree`, a deterministic commit and a non-forced fast-forward
update of `main`. The commit keeps the supplied landing message and trailers, falling back to the
Intent outcome when no message was supplied, and uses the existing noreply sync identity. Its last
paragraph is one trailer block: every message's trailers, a `Co-Authored-By:` credit for each covered
landing's declared agent client unless its own message names a co-author, then Forge's trailers. A source-unchanged landing
advances its mapping without an empty commit.

Git LFS paths (`filter=lfs` in the target State's `.gitattributes`) are
published as Git's clean filter would: GitHub's tree gets the LFS pointer, built
from the Forge digest and size (the LFS oid) without reading the object, and
content that already is a pointer passes through unchanged. Before a new pointer
enters the tree, one GitHub LFS batch request per changed LFS file asks whether
GitHub holds the object; Forge uploads it with the mirror's step token only when
GitHub asks, so objects that came from an import are never re-sent. Uploads read
the object once and are limited to 100 MiB per object; a larger new object stops
the mirror with `GITHUB_LFS_UPLOAD_LIMIT` before any ref moves. The
`.gitattributes` objects travel in the mirror's first source window, so a mirror
makes no extra source query for them.

The reverse holds for [two-way sync](operations/github-app.md#two-way-sync): a pushed
file that is an LFS pointer at an LFS path comes back into Forge as its object's
bytes (the same resolver, limits and errors as an import), so Lanes and checks see
the real file, and the next mirror publishes the same pointer.

Each pushed mirror commit that touches Convex paths starts `.github/workflows/convex-deploy.yml` (dev deploy). Its first job skips, ending green with a notice, any run whose commit has a newer deploy-path commit on `main`, so a drained mirror backlog deploys only the newest head. Dev deploys permit large-index deletions after the schema index guard passes; re-adding an index rebuilds it, and index removal leaves documents intact. The exit bench's own deployment is deployed only by hand: `.github/workflows/convex-bench-deploy.yml` runs on dispatch with a full commit on `main` (`gh workflow run convex-bench-deploy.yml -f ref=SHA`), in its own `convex-bench` environment and deploy key, so builders' landings never move the code under measurement. Its boolean `allow_deleting_large_indexes` input defaults to false; the lead sets it to true only for a bench redeploy that should remove large indexes.

Messages retain trailer order, are capped at 16 KiB UTF-8, have controls stripped
and reserved Forge trailers escaped. [Message metadata](architecture.md#landing-message-metadata)
describes cohort ordering, legacy finish recovery and byte bounds. Existing
history and raw State exports are unchanged; normal landings add no Convex calls.

Hosted credentials are `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`. The App
needs Contents read/write on the mirror repository. Set
`FORGE_GITHUB_SYNC_NAME` and `FORGE_GITHUB_SYNC_EMAIL` to the existing sync
identity, or retain that identity in the imported `githubSync` mapping. Hosted
mirrors reuse that mapping's entry format in indexed `projectGithubMirrorJobs`
rows and retain the latest mapping in `projectGithubMirrors`. Bootstrap uses the
pushed native mapping, or the remote commit's `Forge-State` trailer (falling
back to the import State when GitHub `main` is still the imported commit, then to
the first landing's previous State), and verifies the complete exported
Git tree before trusting it. A mirror turned on after landings therefore catches
GitHub up in its first job with no hand push. `GITHUB_SYNC_BOOTSTRAP_TREE` reports a mismatch;
`GITHUB_SYNC_CHANGED` reports unexpected GitHub main movement. Neither forces
or reconciles external GitHub history automatically.

A failed action retains its cursor and structured error on the job, including
the failed API operation, HTTP status and exact request byte count, without
payloads or credentials. From a JSON error reply it keeps only GitHub's
`message` and `errors[]` (resource, field, code, message), with controls
stripped, token-shaped text redacted and at most 500 characters, so a 4xx
such as a rejected tree is diagnosable from status without a replay. HTTP 5xx and 429 schedule retries of
that cursor after 1, 2, 4 and 8 minutes. Verified blob replies before a failed
request are checkpointed so retry does not repeat the whole window. GitHub can
accept a blob POST and still answer a later tree POST with HTTP 422
"tree.sha X is not a valid blob" (for example when the object already existed,
unreachable, from a deleted check ref). The mirror then re-uploads exactly the
named blobs of that tree from verified Forge bytes and retries the identical
tree once in the same step. That failure and GitHub's other read-after-write lag
(`POST git/commits` 422 "Tree SHA does not exist" for the tree this job just
created) share one bounded policy: a 422 on `git/trees` or `git/commits` whose
message names a missing or invalid SHA this job created or uploaded is retried
by a scheduled step after 2 s and then 10 s (no busy wait, no call on the
healthy path). A third failure ends terminal with GitHub's message kept; every
other 422 is terminal at once. The job keeps its place at the head of the queue
while it retries, so later jobs wait as before. Five
consecutive failures without checkpointed progress end in a terminal failure.
A fully successful step or a durable advance to a different blob resets the
budget; an unsuccessful cursor save does not. Failure details retain validated
GitHub request IDs and numeric rate-limit/retry headers when present, without
request bodies, raw response bodies or credentials.
A transport fault or deadline (`GITHUB_SYNC_NETWORK`), unavailable source bytes
(`SOURCE_UNAVAILABLE`), a GitHub LFS outage (`GITHUB_UNAVAILABLE`) and any other
unexpected exception (`GITHUB_SYNC_FAILED`) share the 429/5xx budget. The job
keeps the exception class and a bounded message with URLs, opaque strings and the
step token removed. Other failures stop immediately. A terminal job's detail
names its resume command. `nforge status ROOT`, `nforge agent ROOT status`
and Now show recorded mirror failure (prefixed with the failing job's State,
which can be older than current main), lag and the next retry time. Status reads
use selected rows through existing discovery/workspace requests, without polling.

After resolving the cause, the project owner runs `nforge github resume PROJECT`
(or Resume in the mirror panel on Now); the operator mutation
`projectGithubMirrorStore:resume` with the job's `jobId` stays for deployment
operators. Resume retains
the cursor, resets the retry budget and fences late callbacks. Failed jobs can
replace stale pending/in-progress tasks; otherwise resume preserves a live task
until it is overdue by eleven minutes (beyond the action runtime limit). A
missing or completed task can be resumed immediately.
The mutation returns `scheduled`, `already-running`, `done` or `missing`, with the
worker step, so a deliberate no-op is distinguishable from a scheduled retry. The owner
command returns `scheduled`, `already-running`, `done`, `retargeted` or `nothing-to-resume`
plus `statusReposted`. It also repairs a mirror whose repository changed: setting the
policy repository now re-points the queue (the old repository's unpublished jobs end `done`
with that reason, the mapping resets and the next landing seeds the new repository), and
`resume` does the same for a project retargeted before that, whose publishes had failed
`GITHUB_SYNC_BINDING` without being the active job. Mirror status lists such failed
non-active jobs (`failedJobs`) and every stopped state carries `nextStep`, the one action
that clears it.
Deterministic commit bytes and GitHub ref observation reconcile lost replies
without a second commit for the State. No periodic retries or idle functions
are scheduled; healthy and terminal jobs schedule nothing. `autoPush:false`
stops future attempts; a request already sent to GitHub can still finish.
Undo published source through a compensating Lane;
published history is retained.

`nforge github connect` turns the mirror on in the owner's one GitHub authorization
(`--no-mirror` connects only; see [GitHub App](operations/github-app.md#connect-and-inspect)).
To change it later, use the agent `set-policy` action (CLI or MCP):

```sh
nforge x ROOT set-policy '{"githubMirror":{"repo":"OWNER/NAME","autoPush":true,"laneRefs":false}}'
```

The setting defaults off and survives autonomy preset changes. To stop it, the owner
person uses Pause or Disconnect in Settings → GitHub mirror; CLI/device
`autoPush:false` writes cannot substitute for that person. Only main is published.
Lane refs remain unpublished.

Automatic projection also omits paths protected by capture's credential-name and
metadata rules even when an imported State retained them. It shares native
capture's source rules: code modules such as `src/secret-crypto.ts`,
`internal/auth/credentials.go` and `src/Secrets.cs`, files under `build/`, `dist/` or
`coverage/`, and exact `.env.example`, `.env.sample` and `.env.template` files are
published. Dotenv values, credential/config files, key files, credential stores
(`.ssh`, `.aws`, `.azure`, `.gnupg`) and VCS/Forge metadata remain excluded. These path rules do not scan file contents. The mapping
records those omitted paths for exact retry. Manual sync retains its existing
exact accepted-tree behavior. Accepted source is never changed by publication.

Local Work status and hosted Settings → GitHub show progress, retry state,
and the last successful push. Contained external merges use the same adoption
path automatically. An uncontained or rewritten remote, or a failed exact lease,
becomes a Needs you conflict with Forge's State and Git head, the expected remote
head and
the observed GitHub head. Local/hosted Work metadata retains the refusal detail
with the external commit IDs, paths and contribution import route. Neither history
is overwritten. Accepting the external change into a new green main lets the
automatic worker resume. Reconcile explicitly; manual `github-sync --push` can reconcile a retained pending operation after the
remote history has been resolved. Published source is undone by a compensating
Lane, never by automatically rewinding GitHub.

Forge checks the exact Candidate for its own repository before accepting it on
main. Its GitHub mirror pushes do not start Verify Forge. The workflow runs on
pull requests and on manual dispatch. Other repositories can configure their
own GitHub Actions workflows to run on mirror pushes.

Two-way GitHub sync (`githubMirror.inbound: true`) brings pushes to GitHub `main` back in as Forge landings and gives every pull request into `main` a Forge check-only run whose result is the `forge/verify` commit status (a fork PR's run waits until a project owner approves it, GitHub's approve-and-run norm); a newer push to the PR supersedes the older run. With the ruleset that `nforge github connect` and `nforge github status` print, imported once by a repository admin, GitHub merges only after `forge/verify` passes and refuses direct pushes to `main`; status reports `protected` or names each missing rule. Details: [two-way sync](operations/github-app.md#two-way-sync).

- **Publish:** in a clean Candidate, choose a repository and optional base. Forge pushes the Candidate's Git projection to `forge/publish/<operation-id>` and opens a PR using your local `gh` login. It never merges. "Check GitHub PR" records the provider's state. Acceptance is reported only after GitHub confirms the merge.
- **Import a PR:** paste a PR URL. This reads with your local `gh` access and writes nothing remotely. It creates an External Intent with the PR's exact head and base. "Create native Candidate" then selects that head. Later pushes appear as new observations. Nothing is absorbed silently.
- **Mirror:** copy an accepted Channel's full history to a new branch `forge/mirror/<id>` in a repository you pick. Existing branches, PRs and `main` are untouched. An optional destination can fast-forward a named branch from an exact previous commit. It is never forced.
- **Export to Git:** a hosted project mirrors accepted main to GitHub ([automatic main mirror](#automatic-main-mirror)); `nforge clone` checks it out.

## Now, Code and Home

In the app, a hosted project opens on **Needs me**. **Needs you** holds only what the reader decides: a landing that waits for their approval (Approve and land / Decline), a settings or fork request asked ahead, a question with choices from another person or an agent with no terminal, and a Lane parked for the reader (below). A failed check, a conflict or a refusal is the Lane owner's to fix: it is an **FYI** row naming who acts next, beside landings, main breaking, checks redone, CI time thrown away, settings and access changes and messages. FYI rows can be dismissed one at a time or with **Clear all**; a newer version of a row shows again. **Loose ends** (folded) lists started work nobody is finishing. Forge is not a chat channel: an agent asks the person running it in its own app, and messages someone else through Forge only when they must decide.

A builder that stops and waits on someone parks its Lane instead of explaining it in a comment: `save {"park":{"holder":"@handle","reason":"…"}}` (or `handle/word-word` for that person's agent run). The named holder sees it under **Needs you** at once; only someone who can already read the project can be named. With no `holder`, the Lane is listed in the Needs me of whoever started it once it has had no activity for 4 hours, marked **parked, no one named**. The yard row and the Lane page show the holder, the reason and how long it has waited. A later save keeps the park; `save {"park":null}` clears it, and landing or abandoning the Lane ends it. The 4-hour comparison runs when the page draws, against the Lane's last activity time already stored, so an idle tab costs nothing.

The older project view, which the site no longer serves (its addresses redirect to the app), opened on **Now**; the paragraphs below that name Now describe that view until it is removed. Its Needs you holds decisions, direct messages, questions and handoffs addressed to the viewer; broadcasts remain in Activity and their scoped conversations; What's changing shows work in motion, with count links to decision Lanes and Accepted today instead of duplicate rows. Lane titles wrap to two lines, with the Intent below and a compact owner name. Quiet Lanes expand from one summary line. Now shows the agent session name when available, otherwise its recorded name or “Agent”, without a second agent badge. Overlap chips wrap beside the file and Compare action; file tooltips hold the advisory detail. Accepted today uses one quiet attribution/check-duration line, including its actor and automatic label, with undo details on hover. Titles resolve the accepted Candidate’s Lane inputs and pinned Candidate dependencies. Cancelled and interrupted checks use static grey status; only queued, preparing and running checks animate. Activity under Now records saves, checks and acceptances, with pending questions and handoffs kept in Needs you. A failed check on a superseded Candidate is grey and links to the later Candidate; “fixed in a later Candidate (passed)” requires a passing check there. The project strip and Home use the native main Channel and its acceptance receipt for native projects, retaining hosted selections for Git projects. Home’s recent list shows one newest entry per Intent. Mobile Now shows only decision and in-progress counts. Live sessions, claims and messages update as they arrive. Live reads drop their server subscriptions when the tab has been hidden for 30 seconds or has had no input for 5 minutes, keep the last values on screen, and subscribe again once on wake.

Now also shows current hosted file overlaps from saved path projections and paths main changed since a Lane’s base, as plain rows with nothing to answer (overlap answers were removed, Issue 853fcde3). One bounded subscription (`projectNowOverlaps:now`) supplies these signals; there is no polling or per-Lane query. Incomplete read windows use the existing partial-results note. Decision metadata shows recorded ages and the viewer’s loaded “Answered today” total; older recovery notices without a timestamp omit their age.

For the project owner, Needs you also lists each open approval request that waits for them (a Lane approval, a fork pull request run or a held settings change) with a **Review request** link to its approval page. Workspace recovery notices also appear in Now’s Needs you panel: **Reverted from main** uses the failed tone and **Fix needed** uses the waiting tone. Failing tests appear below the Intent title from the notice's recorded test list (at most three names and a remainder count; a notice recorded without the list shows no count, and the summary text is never parsed); receipt, audit and undo details stay in the closed **Exact record** fold. Owners and contributors can **Start a fix**, which opens a sibling Lane with the existing recovery brief. Owners can **Close** the Intent after an inline confirmation; its Lane and saved head stay. Other readers see **Open Intent**. Both notice kinds count in the shell’s Needs-you badge and remain until the Intent re-lands or is closed.

Needs you and the situation line wait for the records they derive from: while the Intents, Lanes, Candidates, runs and moves load, or the inbox and overlap signals have not all arrived, an empty panel reads “Reading what needs you…”, and when a record page was refused or failed it reads “Can’t read what needs you.” (reload to try again); only a complete read says “Nothing needs you.” **Not now** hides one decision for the browser session and is keyed by the item plus what it is about (the Lane head, the failed run or the notice), so a new save, a new failure or a new notice for the same Lane or Intent shows again; older dismissals of an item that is listed under a newer version are dropped, and each tab keeps at most 200. The Intent board’s Needs-you pill and Home’s “N need you across your projects” use the panel's own rule for a Lane (a conflict, a landing waiting for review or failed, or a passed check with no landing record). Home reads no check runs or landing entries, so its number covers conflicts and can be lower than the panel's, never higher.

Above 20 rows, Now’s changing Lanes and Work’s Intents, Lanes and Candidates collapse into recorded Initiative groups. Intents without an Initiative remain in No Initiative. When an Intent is linked to several Initiatives, its primary group is the first by Initiative record id, so totals do not double count; Planning retains all links. Groups print exact observed counts and open five rows at a time. Needs you groups by decision kind at scale. People, overlaps and accepted groups also have continuation. Small lists keep their ordinary rows. Planning search also matches an issue’s Initiative title; a matching Initiative with no matching issues remains selectable. Hosted presence reads continue beyond the first 30 roots, and Activity can load earlier events beyond the first 40. Saved source views do not store cockpit filters; ownership areas, labels, maintainer queues and batch actions are not available.

Journey rails show four stops: edited, saved, checked and accepted. Hover or focus a rail for its current state; the Progress header’s (i) explains the stops. Project names have no mode badge.

Application loading uses the Forge mark on the chosen theme, with a single 620 ms arrival (static with reduced motion). Same-page links navigate in place. Typed Intent, Lane-name, note, reply and message drafts offer Keep editing or Discard and leave in the app before navigation; saved or empty inputs and pending network activity never trigger that confirmation. Closing or reloading the document uses the browser warning only for these unsaved drafts.

Imported repositories open a source explorer with Files, Overview and Docs views. Files shows bounded source pages with digests and a file inspector for imports, declarations and identifier references. Links carry a source state, so a stale link asks you to reload. The page subscribes to the import's status (no polling timer) and offers Re-index when the importer can refresh.

An optional `.nforge/home.md` becomes a Home tab. It is ordinary Markdown with `forge` code blocks such as `{"component":"coverage"}`. Components are `coverage`, `imports`, `impact`, `source`, `work`, `evidence` and `releases`. A block can only show data. It cannot run commands or read outside the selected source. `work`, `evidence` and `releases` describe local Work records, which hosted source snapshots do not include, so those blocks show their original text. This repository's own `.nforge/home.md` is an example.

### Lane screen

Lane pages use one detail layout: header actions Hand to an agent · Browse source · ⋯ (Copy link, Get code, Mark complete, Abandon…); main Work map · Check · Changes · Record; side Timeline · Conversation (collapsible); no tabs. A Lane nobody holds shows *Nobody is working on this Lane* with Hand to an agent · Take it · Abandon…. A Lane with no saves is open, never landed.

Lane pages show the edited → saved → checked → accepted journey, the next step, exact-Candidate check evidence, file changes, and a newest-first timeline. They also show the Lane's live conversation. The delegate sheet opens from **Hand to an agent** or **⌘⇧C** (Ctrl+Shift+C on other keyboards).

The Timeline/Conversation column and file list collapse to 36px rails on desktops; the controls remember `forge.lane.side` and `forge.lane.files` in browser storage. Below 1060px both panels remain expanded. **Unified**, **Split**, and **Inline** word diffs share the selected file's comparison and remember `forge.diff.mode`. Changing modes does not fetch source again. File selection loads that file on demand; counts unavailable from a manifest remain absent until known.

Changes keeps the file list it verified for the selected checkpoint. Opening a file reuses that list and checks checkpoint access again before and after downloading the file versions.

Syntax highlighting loads the JavaScript/TypeScript, Python, Java or Rust grammar only when visible code requests it. Parsing and the blob/range token cache run in a module worker. Source appears immediately as plain text; unknown languages, worker failures, truncated comparisons and files above the highlighting threshold keep readable plain text. Syntax classes are scoped to `.diff` and `.source`.

## Planning, Activity and Code

Planning groups Issues under Initiatives, with status and linked-Intent filters, discussion and retained history. Readers can browse hosted planning records; owners edit them. Activity groups recorded events by day, folds consecutive saves from the same Lane, and links pending decisions to Needs you. Filters and exports use the loaded records; Show more reveals additional loaded events.

Code opens Files. Native hosted projects browse the exact `main` head through the existing authorized source-review reader: the manifest populates the expandable tree, and source text is read on demand in pages. Tree dots mark files and folders an open Lane touches, coloured by the most urgent Lane. The This file column shows Changing now, Symbols (top-level JavaScript/TypeScript declarations on the loaded page) and History (the most recent acceptances touching the file). The folder-card Graph mode is removed; identifier reference maps remain available from the indexed file inspector. Imported GitHub repositories retain their source reader.

An editable GitHub import lists the commit tree in one recursive request. A
complete listing streams the commit's archive once and stores each file as a
content-addressed object, proving it against its Git object ID first; files the
archive omits or rewrites (export-ignore, export-subst, LFS) are fetched by Git
blob. Convex sees one prepare and one completion per page of up to 1,000 objects
and no per-file inventory; once every window is stored, the import publishes one
sorted object catalog and selects hosted `main`. No Mac or local owner takes part.
On the t3code repository (about 29,000 files) this takes 2 min 31 s and 2 min 37 s in two runs, until the project is agent-writable
(target: 5 minutes or less). A tree above GitHub's recursive-listing limit (100,000
entries or about 7 MB) is listed in pieces and still streams the archive; only a single
directory above that limit uses directory-by-directory discovery and per-blob reads. Reads use the GitHub
App's installation token when the App is installed on the repository, otherwise
the importer's existing credential.

Editable GitHub imports retain submodules as atomic pointers: path, Git mode `160000`, and pinned commit SHA. `.gitmodules` stays an ordinary source file. Code and Now show `submodule → <url> @ <short sha>`; a submodule is a leaf, never an expandable source folder. Import status reports “N submodules kept as pointers”. Import fetches no submodule repository or contents.

`nforge clone`, `nforge pull` and hosted Lane checkouts check each submodule out at its pinned commit, recursively, the way `git submodule update --init --recursive` does. A submodule directory has its own small `.git`; its HEAD is detached at the pinned commit, and its objects come from a shared per-user cache (`~/.cache/forge/submodules`) that fetches each URL and commit once, shallow, for every clone and Lane. Status, save and every other scan treat that directory as a single entry whose value is the commit its HEAD names. Its files are never captured or reported as added. To bump the pointer, run `git -C PATH fetch origin SHA && git -C PATH checkout --detach SHA` and save: the save records a pointer update. A branch checked out inside the submodule refuses the save with `SUBMODULE_HEAD_SYMBOLIC`. Run `git -C PATH checkout --detach` to fix it.

When a pull or sync moves the pointer, the existing checkout moves to the new commit, and untracked files in it stay. Local edits that the new commit would overwrite are never discarded: the directory is moved beside the checkout (the result's `submodules.kept` names the place), and the pointer file takes its place until you commit or stash there and run the command again. Only credential-free HTTPS URLs (and GitHub SSH spellings, as their HTTPS form) are fetched. A private submodule, or one with another kind of URL, stays a plain file holding the full commit SHA, and the result's `submodules.notice` explains why. Editing that SHA saves a pointer update. `FORGE_SUBMODULES=off` keeps every submodule as a pointer file. Hosted checks materialize submodules too ([submodules in checks](operations/github-actions-checks.md#submodules-in-checks)). Save, composition, landing and the GitHub mirror retain the pointer, and the mirror emits a Git commit entry rather than a blob. Opposing SHA updates produce an atomic conflict for the existing hosted resolution flow.

Settings › Transfer & backups groups local work, source return and archive import into three sections. Copy agent prompt starts local handoff; the Work journal and source pull request downloads share a row, with restore instructions disclosed below. The return checkpoint selector includes its own Load more choice beside Return to Forge. Source verification is disclosed below that row. Archive import uses an English file button and retains private backup history.

The project top bar opens search with ⌘K (Ctrl+K on other keyboards). Search matches current-project Intents, Lanes, Candidates and available indexed files, with up to eight Needs-you and recent entries before typing. Queries group Intents, Lanes, Candidates and Files, showing five per group with a Show all action. Candidates use their composed work as the title and keep their number secondary. Files use the latest indexed main acceptance (or the checkpoint source when main has no acceptance), pinned to that checkpoint and head when opened. File-read failures leave Work results available. The Needs-you pill counts the same visible decisions as Now, including session-local “Not now” choices, and opens that panel. On mobile, the top-bar search icon opens a full-screen palette and the Now tab carries the Needs-you badge. The avatar menu identifies the signed-in person by name and handle, links to Profile and Signed-in devices, contains system, light and dark theme icons with tooltips, and exposes the existing Clerk sign-out action. The retired Appearance settings route redirects to General. Work collection headings read “Work”; their inline segment names the current collection. Filter counts appear only once the existing collection reads are complete; unavailable Planning has no count.

Work’s Intents, Lanes, Candidates and Planning switcher sits beside the page heading. On narrow screens it scrolls horizontally directly below the heading; it does not wrap or occupy a separate navigation band. Counts reuse the hosted workspace’s existing collection counts.

### Lane and Candidate file Map

The changed-files panel has a Files | Map toggle. Map imports its renderer and requests graph data only after a click, then retains it for that mounted exact head. It reuses the Code renderer and static relative JavaScript/TypeScript import parser. The map includes every touched file and its direct imports/importers from the base and head, including deleted files; unsupported and dynamic relationships remain unknown. Added, modified and deleted nodes use distinct labels/colours; node width follows changed-line counts. Other open Lanes mark shared paths, with names on hover and in keyboard labels.

Above 50 touched files, Map starts with expandable directory groups. Collapse folders appears at the right of the Files | Map toolbar while folders are expanded. The canvas fits its content between 240 and 560 pixels, then scrolls internally. Peer markers and their legend share one colour; hovering a marker names the other Lanes. Click or Enter/Space selects a file's diff; untouched neighbours show the unchanged comparison. At narrow widths Map fills the panel and scrolls vertically, without requiring pinch or zoom. Collapsed folders retain every file. Hosted native Maps use the checkpoint-authorized source-review action and need its Map-capable backend deployed.

### Browser feedback and conversations

Failed Intent notes and Lane creation keep the draft. Hosted retries reconcile an unknown earlier
operation using its original payload before applying a different action. Request changes records
feedback against the exact Candidate and sends it to its input Lanes, targeting their reporting session
when available. Lane and Review conversations show sent messages and explicit acknowledgements;
a heartbeat alone is not evidence that a message was seen.

Who's working offers Message and Hand off for each session. Review retains the full line-comment
browser. Session messages open a
compact dialog. For unbound sessions, Copy message copies the draft and then names the session to
paste it into. Failed feedback shows one inline error beside its control; transport details are
available on hover, and an uncertain write asks the reader to check whether it was saved.

### Source links and browser navigation

Copy link on an Intent, Lane, Candidate, save or source file retains its source head.
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
not counted as a completed code change in Now. The project is hosted from birth:
its source authority is the server and hosted `main` is selected, so agents start
and land Lanes with no local native owner. An editable GitHub import is hosted the
same way once it is ready. Imports published before this was the case stay
native-owner until their owner runs `nforge make-editable DEPLOYMENT PROJECT_ID`,
which selects hosted `main` from the already stored import (nothing is uploaded).
It is refused if the source changed after the import; use the owner cutover then.

For the signed-in owner's existing Clerk username, canonical project URLs use that
username and replace the older ID URL in the browser. Other owners keep their
recorded account ID when no username is available to this client; display names
are never turned into invented account handles.

GitHub Settings shows the recorded sync repository (or a single recorded import repository), with labelled Preview and Publish commands. Without a recorded repository it shows Not connected to GitHub and a Preview command with a REPO placeholder. Saved-file read failures keep the Code file tree and breadcrumb visible while retrying the pinned save.

### Check output in the browser

Lane and Review offer one byte-paged log reader with stdout/stderr selection, First failure,
refresh and copyable line links pinned to the run and retained page. Failure rows have a tinted background and rail; First failure scrolls to and focuses the match. The quiet gutter counts 1-based lines from retained output and links to `#L` anchors; byte offsets remain internal paging pins. Running local checks show partial
output; terminal cancelled/interrupted runs stay static. Local reruns retain the Candidate head and
check definition. Cancel reports the returned outcome, including a run that finished before the
request arrived. Hosted Review keeps connected-runner requests alongside the retained check
record. Hosted output reads the selected object checkpoint; when the log is only on the runner
(or in a legacy archive), use `nforge agent ROOT log {runId}` for its retained tail, or
`observe {runId}` and its CI provider link. Scope labels appear only when recorded scope is available.

### Settings and outside contributions

Access lists people by name and @handle with an avatar, without email fallbacks. Owners can autocomplete an existing @handle or enter an email address. Either creates a pending invitation, visible to the project’s access manager and to the invited person on Home, that grants nothing until that person accepts it (see [access](access.md#invitations)). Invitations retain operation identities so retrying a completed invitation does not restore access after removal. Pending invitations can be cancelled.

Contributions lists outside contributors’ proposals. With no outside contributors or proposals it shows one quiet sentence. Contributors with a selected Intent can send changes from their computer through the existing archive proposal flow.

How agents work has project guidance included in every Forge briefing after the repository’s AGENTS.md/CLAUDE.md, and personal guidance for agents the account starts in every project. Autonomy uses the shared switch control; its existing policy and save behavior are unchanged.
