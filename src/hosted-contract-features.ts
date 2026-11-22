// SPDX-License-Identifier: Apache-2.0
// Pure: also runs in the Convex non-Node runtime.

/**
 * Server behaviour a CLI may rely on only once the server it talks to says it implements it
 * (a83b6fd5). The CLI auto-updates as soon as main moves, but the server of the same State deploys
 * later (minutes on the dev mirror; a self-hoster may deploy much later, with any CI). So the CLI
 * names these on the capability read it already makes, and the server answers with the subset its
 * own code implements: no extra call, and an older server that rejects the `features` argument
 * simply advertises none.
 *
 * Rules: add a name in the same change that implements the behaviour on the server; never rename,
 * reuse or remove a name; the CLI keeps the old safe behaviour whenever a name is not advertised.
 */
export const sourceStateFeature = 'source-state';
/** Source/bootstrap version 2 and one descriptor refresh after a root replacement. */
export const sourceStateV2Feature = 'source-state-v2';
export const feedCommitOrder = 'feed-commit-order';
/** An Intent-id-only start asks for its title using the slot reserved for bare status. */
export const startLaneTitle = 'start-lane-title';
/** Undo asks for its mutation in the slot reserved for bare status. */
export const laneUndo = 'lane-undo';
/** Planning asks for versioned wait reasons in the slot reserved for bare status. */
export const planningWaitingFeature = 'planning-waiting-on';
/** The unfiltered Initiative count uses the planning wait feature's discovery slot. */
export const planningInitiativeCountsFeature = 'planning-initiative-counts';
export const initiativeProgressRequested = (input: Record<string, unknown>) =>
  input.counts === true &&
  typeof input.initiativeId === 'string' &&
  input.kind !== 'initiative' &&
  input.status === undefined &&
  input.waitingOn === undefined;
export const hostedContractFeatures = [
  /** Reader expansion precedes this writer: start/save/land accept declared source authorship. */
  'source-authorship-v1',
  /** State-bound physical run and recipe grants; bootstrap replies carry the trusted root pin. */
  'protected-path-notice',
  sourceStateFeature,
  sourceStateV2Feature,
  /** Candidate files read from exact R2 States without a legacy Work generation. */
  'candidate-source-files',
  /** put-planning-item keeps every stored field the put omits (c0255160). Without it the CLI sends
   * the stored kind, title, body, status, links and group, as older servers require. */
  'planning-put-keeps-omitted',
  /** A conflict resolution records the caller's conflicted Lane (sync originLaneId) and completes it
   * when the resolution lands (36a087ea). Without it the CLI sends no originLaneId. */
  'resolution-origin',
  /** The overlap read takes `presence` (Issue 9c8490a4, was presenceVersion:1). Without it the CLI
   * sends no presence argument. */
  'agent-presence',
  /** Board notes: the overlap read takes `board`, and projectBoard:read/post exist (was
   * boardVersion:1). Without it the CLI sends no board argument. */
  'agent-board',
  /** Check enqueue, compose prepare and landing submissions can project the caller's live work budget. */
  'member-work-budget',
  /** Ordinary board/overlap pages accept a separate delivered-directed-note watermark. */
  'board-lane-after',
  /** Ordinary board/overlap pages accept a separate read-project-note watermark. */
  'board-project-after',
  /** Wait delivery: the landing page subscription takes `board`, projectBoardWait:peer exists, and
   * the overlap read lists claims on a first-write path. Without it waits carry no board argument. */
  'board-wait',
  /** The existing check status subscription also takes the Lane inbox cursor. */
  'run-board-wait',
  /** Check waits can read the current epoch, and lifecycle transitions can return a stranded plan's receipt. */
  'source-epoch-recovery',
  /** Save, sync and compose progress subscriptions also accept the existing Lane inbox cursor. */
  'source-board-wait',
  /** Automatic file claims: projectBoardClaims:claim exists, and the overlap read's board arg takes
   * `claim` (lists `touching` and says when the first-write hook should claim). Without it the
   * hook records no claim. */
  'board-claims',
  /** Save evidence may carry `symbolLinks` (changed exports and referenced imports), which the
   * overlap read matches into cross-file advisory notes (3629cf24). Without it the CLI strips them. */
  'overlap-symbol-links',
  /** Capabilities carry every effective agentDefaults key, not only the frozen set older CLIs parse
   * strictly (WIRE_AGENT_DEFAULT_KEYS). Without it the reply has the frozen keys only. */
  'agent-defaults-extended',
  /** Agent session identities (c29d0780): start and projectBoard:post take `agent` (a word-list
   * slug), and actor/author values may read `handle/slug`. Without it the CLI sends no `agent`. */
  'agent-slug',
  /** projectBoard:resolve exists and projectBoard:read takes `all` (friction 9d7bd94f): `board
   * --resolve` withdraws a note, and `board {all:true}` lists resolved ones. Without it the CLI
   * sends neither. */
  'board-resolve',
  /** Agent run on receipts (d730121f): projectHostedLanding:enqueue and
   * projectHostedLandingDesired:submit take `agent` (the session slug), kept outside the request, and
   * the acceptance receipt records it as `agentRun`. Without it the CLI sends no `agent`. */
  'landing-agent-run',
  /** Agent client on receipts (81d12a32): the same two mutations take `agentClient` (the harness
   * and, when declared, the model), recorded on the receipt. Without it the CLI sends none. */
  'landing-agent-client',
  /** projectHostedLandingWithdraw:withdraw exists (78a97771): `land --withdraw` cancels a Lane's
   * live landing by Lane. Without it the CLI refuses and names `cancel {submissionId}`. */
  'landing-withdraw',
  /** Terminal history is read through an authorized, redacting server action; capsuleProtocol:1. */
  'landing-capsules-v1',
  'journal-segments-v1',
  /** Purged Work journal rows (Item 4c9e961e): event pages and exportJournal may carry a purge-planning-item
   * tombstone and purged rows (envelope plus their own command with every word replaced) that name it. */
  'planning-purge-v1',
  /** Purge v2 (purge Lane 2): a purge lists every row of its Item (with the digest of its redacted facts), and
   * purged rows include an Intent-born Item's intent and note rows and writes through an alias. exportJournal
   * refuses a journal with a purge unless the caller sends `purgedRows: 2`, so a v1 or older CLI's local recovery
   * gets CLI_UPGRADE_REQUIRED instead of a row form it cannot replay. */
  'planning-purge-v2',
  /** Revert provenance on CLI landings (Issue 8dbccdfb): projectHostedComposeSelection:page names a
   * revert Lane's `revertOf`, and projectHostedLandingDesired:submit takes `revertOf`, so a landed
   * revert is recorded as compensating and tells the reverted Lane. Without it the CLI sends none. */
  'landing-revert-of',
  /** projectHostedSaveJobs:submit takes the last delta page (`index`, `page`) and stages it in the
   * same transaction (friction f15db544). Without it the CLI stages every page with
   * projectHostedSaves:stage before submitting. */
  'save-submit-page',
  /** projectSourceRun:submit exists (1eef1b43): one action commits a save's, sync's or compose's
   * deferred uploads (at most 100), submits, and runs the first step without the scheduler hop.
   * Without it the CLI commits with projectObjectCommit:commitBatch and submits with the mutation. */
  'source-submit-run',
  /** A save request may name the resolve that follows it (`then`, 1eef1b43): its completion
   * schedules projectHostedResolveChain:run, and projectHostedSaves:progress reports that sync as
   * `chain`. Without it the CLI sends no `then` and prepares the resolve itself. */
  'save-then-resolve',
  /** Prepare hands back upload targets (1eef1b43): projectHostedSaves:prepare takes `uploads` (a
   * save's new raw blobs and delta pages; it refuses SAVE_CONTENT_RECIPE before any operation when
   * one of those blobs is stored only as a recipe) and projectHostedSync:prepare takes `targets`;
   * both reply with `targets` for those pins and the job input, so the CLI makes no
   * projectObjects:prepareBatch call. Without it the CLI prepares with prepareBatch as before. */
  'prepare-upload-targets',
  /** A step that finishes its job publishes a small result inside its own commit, and
   * projectSourceRun:submit takes `progress` (reply `{terminal, state, chain?}` when its step
   * published, with the save's chained resolve run in the same action) and `input` (the job input
   * text, read from memory). Without it the CLI waits on the progress subscription as before. */
  'source-run-publish',
  /** Split save (fea47345 C): projectSourceRun:submit takes `settle: 'background'` for a save. It
   * commits the uploads, submits, records the save's changed paths for overlap at once, and returns
   * `submitted` while the server settles the save on a scheduled step; the client's next command
   * reads its outcome and reports a failed settle. Without it the CLI waits for the settle. */
  'save-settle-background',
  /** Coordination before the queue (D2, Issue 1eb42254): the overlap read takes `scope` (a fresh
   * Lane's declared paths) and its reply may carry `stackOffer` and peer landing phases. Without it
   * the CLI sends no scope. */
  'overlap-scope',
  /** projectHostedSync:prepare takes `stackOn` (D2): stack an unstacked Lane on an open peer's
   * pending head. Without it the CLI refuses stackOn and the stacking:auto setting does nothing. */
  'sync-stack-on',
  /** Exact predecessor pins survive sync/resolve and use the predicted-head check pipeline. */
  'early-resolution-v1',
  /** Upload packs (Issue 98ee14e8): projectObjects:prepareBatch takes `pack` and
   * projectHostedSaves:prepare takes `uploadPack` (src/object-pack-upload.ts), so several new small
   * objects go up as one pack with one PUT; the commit reads the pack and checks every member digest
   * before it writes their rows, which then read back with one ranged GET per run. Without it the
   * CLI PUTs each object. */
  'upload-packs',
  /** Server preflight gate (Issue 029138ef): projectHostedLanding:enqueue and
   * projectHostedLandingDesired:submit take `gates`, the CLI's preflight result per composed Lane
   * head; a project with preflight require refuses a new agent landing without it. Without the
   * feature the CLI sends nothing (an older server judges nothing). */
  'land-gates',
  /** Final save submission takes clientMs; its receipt returns durationMs. Land gates carry
   * saveMs/preflightMs into landing timing, using existing calls only. */
  'save-preflight-timing',
  /** projectHostedLanding:enqueue and projectHostedLandingDesired:submit take `tokens`, the agent's own reported
   * token use (Item a61d3c91), kept on the landing row for Stats. Without it the CLI sends none. */
  'landing-tokens',
  /** Unsaved-work snapshots (Issue 7ac4e32f): projectLaneSnapshots:* exist and capabilities carry
   * `laneSnapshots` (policy autoSnapshot). Without it the CLI takes no snapshot and refuses
   * `x snapshots`. */
  'lane-snapshots',
  /** Snapshot packs (Issue 7ac4e32f): projectLaneSnapshots:prepare takes `pack` (one object for the
   * pages and changed files, live without `commit`) and capabilities carry `snapshotIntervalMinutes`
   * (policy autoSnapshotIntervalMinutes). Without it the CLI sends one object per file and commits. */
  'lane-snapshot-packs',
  /** A check run may use the ci-status provider (flip 3): projectHostedCheckRead:status takes
   * `features` and sends such a run only to a caller naming this feature. Without it the read
   * refuses that one run by name, so an older CLI never receives a configuration it cannot parse. */
  'ci-status-check',
  'check-report-detail',
  /** put-planning-item runs in the revision-free mutation projectWorkCommand:command (flip 5 S5): one
   * call, the item version is its only check (ITEM_CHANGED). Without it the CLI reads the Work
   * revision and calls the revision-checked action, retrying when an unrelated write moved it. */
  'planning-put-mutation',
  /** Capabilities carry `main`, the selection projectHostedChannels:current returns, from the channel
   * row the read already loads (686ecdde). The CLI's release check and a command's first main read
   * take it instead of their own current calls. Without it the CLI reads current as before. */
  'capabilities-main',
  /** Indexed planning filters and bounded state counts on the existing records read. */
  'planning-filtered-reads',
  /** History logs accept a client metadata-cache inventory and return commit/tree indexes. */
  'history-log',
  /** Optional agent declarations on exact save and landing requests; absent is distinct from empty. */
  'save-declarations',
  /** Source-keyed backlog preparation and atomic import pages; writer enablement is deployment staged. */
  'planning-import-pages',
  /** Planning model fields (d3357f40, src/planning-model.ts): puts store order, type, parentId, owner, relations
   * and hidden, and planning rows carry them. Without it the CLI refuses to send them, since an older server would
   * drop them silently. */
  'planning-model',
  /** Optional session-bound Lane ownership; writers remain behind accessIdentities.laneHolders. */
  'lane-holder-v1',
  /** Backlog batches (65b0e706): projectPlanningBatch:apply runs up to 100 planning writes in one call. Without it
   * the CLI refuses put-planning-item {batch}. */
  'planning-batch',
  /** Optional current lifecycle state on the existing Lane head read. */
  'lane-status-state',
  /** start takes openLanesVersion 2: each listed open Lane carries `resolves` when it is a resolution Lane, and the
   * CLI names the Lane it replaces with the abandon command (d9e1ac62). Without it the CLI asks for version 1. */
  'start-open-lanes-resolves',
  /** Optional in-flight landing (operation, phase) on the existing Lane head read (7da396ed). */
  'lane-status-landing',
  /** The learned preflight guard set (13ea93bf): land gates take `ran` and `runs`, a failed check
   * learns from them, and start takes `guardRevision` and replies `guardSet` when it differs.
   * The capability read takes and replies the same (sent by `open`, `preflight` and `land`; an
   * older server's refusal of the argument drops it). Without the feature the CLI sends no gate
   * fields and preflight runs no learned guards. */
  'preflight-guard-set',
  /** A member's start of an open Issue has the server move it to in progress (convex/projectPlanningStart.ts, Item
   * d3357f40). The CLI then reports the member's refused status write as moved by the server; without it the
   * refusal is reported as before. */
  'planning-start-move',
  /** Save delta changes may carry `lines` (Item c2388099): +/- counts the CLI measured from its own line sketches,
   * kept on the Lane's overlap row for the Lane page. Without it the CLI sends none (older servers validate delta
   * pages strictly) and the page shows no counts. */
  'save-line-counts',
  /** Explicit Lane holds (e1633718): projectHostedLanePark:set parks a Lane on a holder with a reason, or clears it.
   * Without it the CLI refuses `save {park}` before saving. */
  'lane-park',
  /** projectHostedLanding:enqueue and projectHostedLandingDesired:submit take `maxChecks` and the
   * queue answers projectHostedQueueRoom:room (ad80e037); the switch FORGE_QUEUE_LAND_WHEN_ROOM decides
   * whether it is honoured. Without the feature the CLI refuses `land {maxChecks}` itself. */
  'land-when-room',
  /** Capabilities carry `mainToday` (Item 32e8de50): the top bar's landings today and first-try share. Asked only by
   * a bare status (hosted-capabilities-early.ts `capabilityOptions`), so no other command reads the summary row. */
  'main-today',
] as const;
export type HostedContractFeature = (typeof hostedContractFeatures)[number];

/**
 * Features this build has NO fallback for. The pre-switch canary holds the switch to a build while
 * the server lacks one (bounded by the canary back-off); every hosted reply then names it in
 * `serverContract.missing`, and the command that needs it must refuse rather than guess. Prefer a
 * fallback: list a feature here only when the old behaviour would be unsafe or impossible.
 */
export const hostedRequiredFeatures: readonly HostedContractFeature[] = [];

export const MAX_CONTRACT_FEATURES = 64;

/** The subset of the asked names this server implements (server side). Feed consumers
 * ask explicitly; the installed CLI's general discovery already uses its full feature budget. */
export const advertisedFeatures = (asked: readonly string[]) => [
  ...(asked.includes(feedCommitOrder) ? [feedCommitOrder] : []),
  ...(asked.includes(startLaneTitle) ? [startLaneTitle] : []),
  ...(asked.includes(laneUndo) ? [laneUndo] : []),
  ...(asked.includes(planningWaitingFeature) ? [planningWaitingFeature] : []),
  ...(asked.includes(planningInitiativeCountsFeature) ? [planningInitiativeCountsFeature] : []),
  ...hostedContractFeatures.filter(feature => asked.includes(feature)),
  ...(asked.includes('feed') ? ['feed'] : []),
];

/** Required features the server did not advertise (client side). */
export const missingRequiredFeatures = (
  advertised: readonly string[] | undefined,
  required: readonly string[] = hostedRequiredFeatures,
) => required.filter(feature => !(advertised ?? []).includes(feature));
