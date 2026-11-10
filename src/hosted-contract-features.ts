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
export const hostedContractFeatures = [
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
  /** Wait delivery: the landing page subscription takes `board`, projectBoardWait:peer exists, and
   * the overlap read lists claims on a first-write path. Without it waits carry no board argument. */
  'board-wait',
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
   * live landing by Lane. Without it the CLI refuses and names `x cancel {submissionId}`. */
  'landing-withdraw',
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
  /** put-planning-item runs in the revision-free mutation projectWorkCommand:command (flip 5 S5): one
   * call, the item version is its only check (ITEM_CHANGED). Without it the CLI reads the Work
   * revision and calls the revision-checked action, retrying when an unrelated write moved it. */
  'planning-put-mutation',
  /** Capabilities carry `main`, the selection projectHostedChannels:current returns, from the channel
   * row the read already loads (686ecdde). The CLI's release check and a command's first main read
   * take it instead of their own current calls. Without it the CLI reads current as before. */
  'capabilities-main',
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

/** The subset of the asked names this server implements (server side). */
export const advertisedFeatures = (asked: readonly string[]) =>
  hostedContractFeatures.filter(feature => asked.includes(feature));

/** Required features the server did not advertise (client side). */
export const missingRequiredFeatures = (
  advertised: readonly string[] | undefined,
  required: readonly string[] = hostedRequiredFeatures,
) => required.filter(feature => !(advertised ?? []).includes(feature));
