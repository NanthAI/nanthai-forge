// SPDX-License-Identifier: Apache-2.0
import { requireAgentRoot } from './agent-root.js';
import { validateHostedCliCommand, validateNativeFrictionCommand } from './hosted-cli-validation.js';
import { actionableNotFound, resolveShortLaneId } from './argument-errors.js';
import { resolve } from 'node:path';
import { hostedAgentHelp } from './hosted-agent-help.js';
import { callerOverlaps } from './agent-caller-overlaps.js';
import { hostedAgentAddress } from './hosted-agent-address.js';
import { discoversCapabilitiesFirst, startEarlyCapabilities } from './hosted-capabilities-early.js';
import { hostedAgentRoot } from './hosted-agent-journal.js';
import { LAND_CHILD_ENV } from './hosted-land-child-env.js';
import { canonicalOperationIds } from './operation-id-case.js';
import { canonicalCandidateAction, noticeViewAlias } from './candidate-names.js';
import { aliasNotice, landSaveCommand, lowerVerb, newForm, parseVerbForm } from './agent-verbs.js';
import { parseWaitBudget } from './agent-operation-wait.js';
import { recordTurnWait } from './agent-turn-work.js';
import { readFileSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';
import type { AgentWorkflow } from './agent-workflow.js';
import type { PredictiveOverlap } from './agent-predictive-overlap.js';
import { invariant } from './errors.js';
import { housekeepingLines, type IdleLane, type OtherRunLane } from './lane-prune.js';

/** The native owner workflow (and its local Work store) loads only for a native root: every hosted
 * command would otherwise pay its import at start. */
async function nativeWorkflow(root: string): Promise<AgentWorkflow> {
  return new (await import('./agent-workflow.js')).AgentWorkflow(root);
}

export const AGENT_HELP = `Forge native owner agent workflow
Hosted checkout help is generated from its enforced contract: nforge agent HOSTED_ROOT --help.
Hosted command reference: nforge docs agents/hosted.
  nforge agent ROOT start|save|land [--MODE] [JSON | --command-file FILE]
  nforge agent ROOT READ [JSON | --command-file FILE]
  nforge x ROOT OPERATOR-ACTION [JSON | --command-file FILE]
  nforge agent ROOT VERB [--MODE] --help
  nforge mcp ROOT --agent

Typical loop:
  nforge agent ROOT start '{"outcome":"Fix the login bug"}'
  (edit files in the returned path)
  nforge agent ROOT land --save '{"laneId":"LANE_ID","message":"Fix login"}'

Three verbs:
  start               create or join an Intent and open a Lane
    --open            materialize a hosted Lane          --reopen  reopen retained work
  save                save current edits (a clean save keeps the unchanged head)
    --sync            bring main (or the stack parent) into the Lane, like git pull
    --candidate       compose saved inputs into a Candidate
    --check           run the configured check on an exact Candidate
    --contract        confirm the measured proving-test contract
    --handoff --report --friction --decision --overlap-answer --overlap-answers
                      record that note on the Lane (metadata only)
    --preview         local composed static preview, no acceptance
  land                submit saved Lane heads; unsaved edits stay untouched
    --save            save, sync if main moved, compose, check and land (accept:true)
    --save --check-only   the same without landing
    --resume-ready    resume landings waiting on dependencies
    --withdraw        hosted: end this Lane's live landing (known failing check), keep the Lane

land --save waits for the outcome (--no-wait returns after submission; a killed client never stops it).
--message-file FILE|- reads message text; --command-file - reads the JSON from stdin.
Hosted start prints {"started":{laneId,path}} on stderr first; path:DIR opens there, open:false skips the checkout.
Heavy local commands: nforge heavy CMD. Settings: nforge settings; docs: nforge docs parallel-work-defaults.

land --save checkpoints, syncs the Lane with main if main moved, composes, runs the
"verify" check (or the only check) and requests acceptance under project policy.
CHANNEL_CHANGED retries use a per-Channel landing queue (maxRetries defaults to 3);
receipts list all attempts and waiting positions.
New supervised projects stop at awaiting-review; a person accepts their checked Candidate.
policy reads settings; nforge x ROOT set-policy selects a preset or edits fields (custom).
laneUpdates:ask stops at sync-required when main moved; nforge x ROOT undo-sync restores
a recorded pre-sync save and refuses newer edits unless force:true.
start, save, save --sync, land --save and Lane status include a local peers digest; scope:{paths:["src/file.ts"]}
declares paths; start retains planned claims until the Lane closes.
nforge x ROOT take {laneId,takeover:true} hands another actor’s Lane to you with its context. peers {laneId,detail:true} reads full details.
save --friction captures workflow cost in owner Work; improve groups it; x friction-triage records a decision.
Hosted: friction-list {id?,status?,area?,laneId?,search?,limit?,cursor?} reads one newest-first page (default status open; a detail cut at 400 characters says detailTruncated, read it whole with {id}); x friction-triage {frictionIds,status:"dropped",reason} dismisses, {status:"planned",planningItemId} links an Issue.
Native: start/land --save frictionIds:[ID] links a fixing Lane and closes reports when it lands. Hosted: start and land --save refuse frictionIds; once the fix is accepted, x friction-triage {frictionIds,status:"fixed",laneId} records it.
After save --sync, resolve any conflict markers, then land --save again. Inside a Lane directory laneId may be omitted.

Omitted operationId and pins are filled from current state and returned under
"resolved". After an unknown reply, retry with your request plus "resolved".
Once land --save has saved, resume its retained request with:
  nforge agent ROOT land --save '{"operationId":"ORIGINAL_UUID"}'
Use the parent operationId, not an attempt's child operation ID.

Hosted addressing: pass {url,projectId,...} on this same command surface, or use
a hosted Lane checkout ROOT. No native owner/listener is needed. Read capabilities
and use status/observe for finite reads. Hosted also supports resolve and x revert.
Hosted save --sync {candidateId} opens an exact conflict draft. Edit its files, call resolve
in the returned root (your own folder when the conflict came from it; see its WORK IN line),
then land --save there; a clean saved resolution needs no fake edit.
Hosted land --save prepares conflict files automatically; pending source work stays durable.
Hosted owners configure checks with x configure-check, x configure-runner and check-settings.
Hosted commands retain generated UUIDs and exact pins in ROOT.forge-client/agent;
retry identical parameters after a lost reply. A new explicit operationId starts new work.
Hosted start returns Lane pins; start --open materializes it; land --save saves an opened Lane,
composes and submits durable agent landing. Pending is not accepted.

Project agent defaults (nforge agent ROOT policy shows them; docs/parallel-work-defaults.md):
preflight runs the saved head's affected tests here and records the result; land --save and the
server refuse without it (preflight:require). ack answers every pending overlap notice; under
overlapGate:block this CLI refuses land --save while a blocking notice is open (advisory, client-side
only; trial-merge conflict notices replace it, Issue 853fcde3). Receipts carry unsavedFor and a save nudge; urgent is owner-only.

Reads: tests, status, landing, observe, wait, log, link,
       records, candidate, provenance, candidates, review, diff, show, history, brief, peers,
       handoff-read, making-of, metrics, improve, decisions, friction-list, policy, check-settings, capabilities,
       planning (hosted backlog; writes: put-planning-item, comment-planning-item; start planningItemId).
Operator (nforge x ROOT ACTION): accept, cancel, revert, undo-revert, undo-sync, abandon,
       complete, complete-merged, abandon-dormant, pin, clean, take, guidance, pre-edit, install-hooks, uninstall-hooks,
       friction-triage, set-policy, define-check, configure-check, configure-runner, prioritize.
Old action names (checkpoint, sync, compose, run, check, finish, open, reopen, land-ready,
confirm-tests, handoff, report, friction, decide, peer-ack, integrate, and operator actions under
agent) still work: they print their new form on stderr; JSON, results and replay identity are unchanged.
start stackOn:LANE_ID bases a native Lane on that parent’s latest saved head and waits for its landing.
save --sync restacks onto the latest parent; after landing it targets main. ontoMain:true detaches explicitly.
status/peers/pending show the chain, parent movement and abandonment.
start intentId adds a sibling Lane; land --save with:[laneId] uses saved siblings and orders high overlaps when accepting.
after:{intentId} or after:{viewId} waits for that work to land; land --resume-ready resumes waits.
land --save and x accept complete included Lanes; the Intent completes when all its Lanes are done (keepOpen:true keeps the Lanes open).
Hosted landing also completes the landed Lanes' Intent (Closes #N) even if they stay open, then planning closes the Issue once its Done-when lines are ticked; closes:false makes it Refs-only (and keeps the Lanes open like keepOpen), policy lifecycle.closeOnLand:"off" turns it off.
Lanes show merged:true when their head is already in a Channel; x complete-merged
completes those. x clean is a dry run until apply:true. save --check needs only {"laneId"}; log accepts tail:BYTES, shard:N (or "static"), and attempt:N (default 1).
start records actor:"agent-name" (or FORGE_AGENT_NAME, then FORGE_ACTOR).
Use distinct names in concurrent shells; tool optionally names the agent tool.
making-of reads one Intent's derived record (Lanes, saves, runs with queue/run time,
landings, sessions); save --report records self-reported harness, model and token totals.
candidate and candidates read pinned results; view and views are deprecated aliases (stderr notice only).
JSON fields (viewId, views) and Work formats are unchanged.
Read the packaged agent skill: nforge docs agent.
`;

const examples: Record<string, unknown> = {
  capabilities: {
    url: 'https://deployment.convex.cloud',
    projectId: 'PROJECT_ID',
  },
  open: { laneId: 'LANE_ID', paths: ['src'] },
  save: { laneId: 'LANE_ID', message: 'Save edits' },
  'recover-apply': { applyOperationId: 'APPLY_OPERATION_ID' },
  resolve: { laneId: 'RESOLUTION_LANE_ID', message: 'Resolve conflict' },
  check: { candidateId: 'CANDIDATE_ID', checkId: 'CHECK_ID' },
  revert: {
    target: { kind: 'receipt', receiptId: 'RECEIPT_ID' },
    message: 'Revert acceptance',
  },
  handoff: {
    laneId: 'LANE_ID',
    summary: 'What changed and why',
    tests: [
      {
        command: 'node --test tests/example.test.mjs',
        passed: 3,
        failed: 0,
        skipped: 0,
      },
    ],
    unrun: ['Full suite'],
    next: ['Lead reviews and lands'],
  },
  'handoff-read': { laneId: 'LANE_ID' },
  friction: {
    title: 'Check interrupted',
    detail: 'Runner stopped before completion',
    area: 'checks',
    cost: { minutes: 5, retries: 1 },
  },
  'friction-triage': {
    frictionIds: ['FRICTION_ID'],
    status: 'planned',
    planningItemId: 'ISSUE_ID',
    reason: 'Next check-runner slice',
  },
  'friction-list': { status: 'open', limit: 50 },
  improve: {},
  metrics: { from: '2026-10-14', to: '2026-10-26' },
  decide: {
    target: { kind: 'intent', intentId: 'INTENT_ID' },
    decidedBy: 'Owner',
    what: 'Use the contract check',
    why: 'Keep the landing loop short',
    overrides: {
      kind: 'default',
      description: 'Full-suite landing gate',
      link: 'docs/workflows.md',
    },
  },
  decisions: { target: { kind: 'project' } },
  wait: {
    laneIds: ['LANE_ID'],
    operationIds: [],
    until: 'terminal',
    timeoutSeconds: 600,
  },
  integrate: { laneIds: ['LANE_ID', 'OTHER_LANE_ID'] },
  tests: { laneId: 'LANE_ID' },
  'confirm-tests': {
    candidateId: 'CANDIDATE_ID',
    runId: 'RUN_ID',
    expectedHead: 'HEAD',
    expectedVersion: 0,
    operationId: 'UUID',
  },
  'pre-edit': {
    laneId: 'LANE_ID',
    paths: ['src/file.ts'],
    conversation: { agent: 'codex', sessionId: 'SESSION', turnId: 'TURN' },
  },
  'install-hooks': { scope: 'user' },
  'uninstall-hooks': { scope: 'user' },
  peers: { laneId: 'LANE_ID', detail: true },
  'peer-ack': {
    laneId: 'LANE_ID',
    noticeId: 'NOTICE_ID',
    choice: 'accept-order',
  },
  take: { laneId: 'LANE_ID', takeover: true },
  link: { laneId: 'LANE_ID', path: 'src/file.ts', line: 42 },
  candidate: { viewId: 'CANDIDATE_ID', offset: 0, limit: 20 },
  provenance: {
    viewId: 'CANDIDATE_ID',
    file: 'src/file.ts',
    lines: true,
    offset: 0,
    limit: 20,
  },
  candidates: { laneId: 'LANE_ID', offset: 0, limit: 20 },
  brief: { situation: 'continue-lane', laneId: 'LANE_ID', agent: 'generic' },
  policy: {},
  'approve-link': { operationId: 'LANDING_UUID' },
  'request-approval': { laneId: 'LANE_ID', reason: 'Why the owner should look before this lands' },
  'set-policy': { operationId: 'UUID', preset: 'trusted' },
  'undo-sync': { laneId: 'LANE_ID', syncOperationId: 'SYNC_UUID' },
  guidance: {
    operationId: 'UUID',
    scope: 'project',
    agentGuidance: 'How agents should work',
  },
  'land-ready': {},
  start: { outcome: 'Describe the intended change' },
  landing: { operationId: 'UUID' },
  land: { operationId: 'UUID', laneIds: ['LANE_ID', 'OTHER_LANE_ID'] },
  checkpoint: { laneId: 'LANE_ID', message: 'Describe the save' },
  sync: { laneId: 'LANE_ID' },
  compose: {
    operationId: 'UUID',
    intentId: 'INTENT_ID',
    inputs: [{ laneId: 'LANE_ID', head: 'HEAD' }],
  },
  finish: { laneId: 'LANE_ID', message: 'Describe the change', accept: true },
  'define-check': {
    name: 'verify',
    executable: '/absolute/node',
    args: ['check.mjs'],
    environmentLabel: 'Local configured runtime',
  },
  run: { laneId: 'LANE_ID' },
  observe: { operationId: 'ORIGINAL_UUID', waitMs: 1000 },
  log: { operationId: 'ORIGINAL_UUID', stream: 'stderr', tail: 4096 },
  prioritize: { submissionId: 'SUBMISSION_ID', priority: 'urgent' },
  ack: { laneId: 'LANE_ID', choice: 'accept-order' },
  preflight: { laneId: 'LANE_ID', run: false },
  'source-pack': {},
  cancel: { operationId: 'ORIGINAL_UUID' },
  accept: { viewId: 'CANDIDATE_ID' },
  complete: { laneId: 'LANE_ID' },
  abandon: {
    laneId: 'LANE_ID',
    reason: 'Superseded by accepted work',
    saveFirst: true,
  },
  reopen: { laneId: 'LANE_ID' },
  'complete-merged': { channel: 'main' },
  'abandon-dormant': { apply: false },
  pin: { laneId: 'LANE_ID', pinned: true },
  clean: { apply: false, kinds: ['check-workspaces', 'lane-deps', 'lanes'] },
  status: { laneId: 'LANE_ID' },
  records: {
    collection: 'lanes',
    state: 'active',
    merged: false,
    offset: 0,
    limit: 50,
  },
  'making-of': { intentId: 'INTENT_ID' },
  planning: { status: 'open', limit: 50 },
  'put-planning-item': {
    kind: 'issue',
    title: 'Outcome',
    body: 'Why and acceptance',
    status: 'open',
  },
  'comment-planning-item': { itemId: 'ITEM_ID', text: 'Decision and why' },
  report: {
    laneId: 'LANE_ID',
    harness: 'claude-code',
    model: 'MODEL',
    tokens: { input: 1200, output: 340 },
  },
  diff: { laneId: 'LANE_ID', paths: ['src/file.ts'] },
  show: { state: 'STATE', path: 'src/file.ts' },
  review: {
    kind: 'lane',
    id: 'LANE_ID',
    expectedHead: 'HEAD',
    paths: ['src/file.ts'],
  },
};
const strict: Record<string, unknown> = {
  finish: {
    operationId: 'UUID',
    laneId: 'LANE_ID',
    expectedHead: 'HEAD',
    message: 'Describe the change',
    checkId: 'CHECK_ID',
    expectedDefinition: 'DEFINITION',
    accept: { expectedPrevious: 'CURRENT_CHANNEL_HEAD' },
  },
  accept: {
    operationId: 'UUID',
    viewId: 'CANDIDATE_ID',
    expectedHead: 'HEAD',
    expectedPrevious: null,
  },
  'configure-check': { name: 'verify' },
  'configure-runner': { provider: 'self-hosted' },
  'check-settings': {},
};
function actionHelp(action: string): string {
  invariant(action in examples, 'BAD_ARGUMENT', 'Unknown agent action. Use agent --help.');
  const form = newForm(action, examples[action] as Record<string, unknown>, false) ?? action;
  const command = form.startsWith('x ') ? `nforge x ROOT ${form.slice(2)}` : `nforge agent ROOT ${form}`;
  let result = `${command} '${JSON.stringify(examples[action])}'\n`;
  if (strict[action]) result += `Fully pinned: '${JSON.stringify(strict[action])}'\n`;
  if (action === 'start' || action === 'sync')
    result +=
      'start stackOn:LANE_ID uses the parent’s saved head; sync restacks onto its latest save, or main after its receipt. sync ontoMain:true detaches and reapplies only the child delta. Resolve conflicts then checkpoint. Child finish/land waits for the parent; land-ready resumes waiting finishes.\n';
  if (action === 'configure-check' || action === 'configure-runner' || action === 'check-settings')
    result +=
      'Hosted project owner only. configure-check imports the named check (default verify) from hosted Work, checkId selects one by id, or command:{name,executable,args,environmentLabel} defines one (optional selection:{scope:"changed-paths",shards:N} lets a custom command scope itself or shard; docs/workflows.md#check-command-scope). configure-runner provider:"self-hosted" (legacy alias "mac") fills machineId (kept from the current machine runner), runtime, platform and environment from this package and process; optional labels:["linux","build"] describe routing to this machine, so run it in the worker\'s exact environment; provider:"github-actions" with repository:"OWNER/NAME" and optional runsOn:"LABEL" or runsOn:["self-hosted","linux","x64"] (default ubuntu-latest) selects the Convex-dispatched GitHub Actions runner (the server derives runtime and environment and checks the App installation and its Actions permission; no installation ID or secret); publicLogs:true records that the owner accepts check logs as visible as that repository (kept while the repository stays the same; false withdraws it; receipts then say check logs are public); submodules:{"OWNER/NAME":true|"public-logs"|false} merges the private submodule repositories checks may read (refused by default; true allows one on runners with private logs, "public-logs" also where logs are public, false removes it; kept while the repository stays the same); isolation:"shared" lets project code run as the runner user where the job cannot start it as its own Candidate user (macOS or Windows self-hosted runners; such checks otherwise fail setup), "user" withdraws it (kept while the repository stays the same); configuration:{...} sets another provider. expected pins the current digest (default: read now; null for none). Identical parameters replay their first result; pass a new operationId to change again. check-settings is read-only and lists blockers.\n';
  if (action === 'integrate')
    result +=
      'Compose main plus latest saved active Lanes and run local static checks. Omit laneIds for all checkpointed active Lanes. No acceptance or remote runner. set-policy integrationPreview:{auto:true} enables debounced previews after saves and before landing; default false. Cached by exact source and check inputs.\n';
  if (action === 'wait')
    result +=
      'Streams JSON lines with resumable cursors; pass cursor with the same targets after reconnect. --text prints one line per event. until:any-change observes a baseline then waits for a change. Exit 0: all terminal (including failed outcomes) or any change; 2: timeout. Target ok and summary successful report outcome success. No checks or drivers are started.\n';
  if (action === 'handoff' || action === 'handoff-read')
    result +=
      'Record or read the latest optional delivery handoff on a Lane. Tests are self-reported; matching saved-head check operation IDs are linked automatically as Forge-recorded evidence. Reuse operationId and original inputs after an unknown outcome. Private Intent notes preserve handoffs through portable Work export/import.\n';
  if (action === 'review')
    result += `Candidate: ${JSON.stringify({ kind: 'view', id: 'CANDIDATE_ID', expectedHead: 'HEAD', expectedBase: 'BASE', expectedStatus: 'clean', paths: ['src/file.ts'] })}\nUse full 40- or 64-character source digests; abbreviated heads are invalid. Omit paths for changed-path summaries. Body budget: maxBytes 1024..48000 (default 12000), context 0..10 (default 3), limit 1..100 (default 20), offset 0 or higher. Continue with nextOffset and expectedReviewTree:reviewTree; keep the same source pins.\n`;
  if (action === 'diff')
    result +=
      'Select laneId for base-to-live changes, or from/to full State digests for an immutable comparison. Omit paths for a summary; paths selects exact relative files and contextual hunks. Same budgets and pagination as review: maxBytes 1024..48000 (default 12000), context 0..10, limit 1..100, offset; continue with returned head/base and expectedReviewTree. Lane comparisons accept expectedHead.\n';
  if (action === 'show')
    result +=
      'Select exactly one state (full digest), laneId (saved head) or channel ("main": its current head), plus a relative file path. Hosted checkouts default to the opened Lane and accept channel:"main"; at:"main" is the same, and at:"base" reads the Lane\'s pinned base (the main it started from, not later landings) so a file can be compared without the project clone. Writes exact bytes to stdout without JSON or an added newline. Binary/invalid UTF-8 or files over 1 MiB require force:true. MCP returns source pins and content with encoding utf8 or base64.\n';
  if (action === 'history')
    result +=
      'Hosted projects imported from GitHub keep their Git history. op:"log" {commit?,path?,limit?,skip?}, op:"blame" {path,commit?,start?,end?}, op:"show" {path,commit?,force?} (exact bytes on stdout), op:"status". commit is a hex id; default is the newest stored main commit (main\'s latest GitHub-mirrored commit, else the import commit). One server call per read checks access; packs download once per machine into the history cache and git reads them. Owner: op:"limit" {bytes} sets the per-project history limit (default 1 GiB); op:"retry" re-runs a failed or over-limit history import.\n';
  if (action === 'link')
    result +=
      'Select exactly one laneId, viewId or save (full source digest). path is an optional relative source file; line requires path. Links target the hosted app; an unpublished head may be unavailable until source is pushed.\n';
  if (action === 'run')
    result +=
      'Optional tests:["tests/example.test.mjs"] replaces only the standard check test selection. Static checks still run. Explicit lists (including []) are partial evidence and cannot satisfy a landing gate or check reuse.\n';
  if (action === 'observe' || action === 'log' || action === 'cancel')
    result +=
      'operationId is the nested check run operation ID, not the finish operation ID. Resume an admitted finish with wait {operationIds:[ORIGINAL_UUID],until:"terminal"}. Replay its full original request plus resolved pins only when admission is unknown.\n';
  if (action === 'cancel')
    result +=
      'Hosted cancel takes {submissionId,operationId?}: submissionId selects a landing request and operationId identifies this cancellation. An already accepted request returns its receipt; Lane lifecycle stays independent; an unneeded hosted check is cancelled when its last live submission leaves.\n';
  if (action === 'withdraw')
    result +=
      "Hosted: land --withdraw {laneId?|submissionId?,reason?,operationId?} ends this Lane's live landing (or, with submissionId from queue, that landing on whatever Lane holds it) (composing, queued, checking or ready) when you know its check will fail. One call; Lane author or project owner. The Lane, its saves, Candidates and recorded check results stay; the unfinished check stops once no other landing needs it, and peers stacked on it recompose without it. The receipt's confirm.waitCommand (the original landing wait) returns LANDING_CANCELLED at once; then fix, save and land --save again (a new operation). A replay of the same operationId returns the first receipt. Already accepted: nothing changes.\n";
  if (action === 'peer-ack')
    result +=
      'Use noticeId from peers detail:true. choice is accept-order, swap or split; optional text explains the advisory proposal. Reuse operationId and inputs after an unknown outcome. This records an answer; it does not resolve source conflicts.\n';
  if (action === 'finish')
    result +=
      'wait:false returns after durable submission; the owner worker drives it. If offline, work stays pending. Observe status, pending-status or wait with the returned operationId. Omit wait (or true) for synchronous compatibility; changing wait replays the same work. preview:"skip" overrides enabled local integration exclusions for a new finish operation. with:[LANE_ID] includes saved sibling heads. Acceptance groups compatible heads and checks high overlaps separately in order on current main. after:{intentId} or after:{viewId} records a dependency; rerun the same request or land-ready after it lands. Omit accept to check only. accept:true means main at its current head. If main moved, finish syncs first; a sync conflict stops with phase "sync" and markers in the Lane. CHANNEL_CHANGED automatically retries sync/check/accept under the landing queue (maxRetries:3 by default, 0 disables retries). Receipts include attempts and queue positions. CHANNEL_DIVERGED means the Candidate lacks the Channel head: sync and finish again. CONTRACT_RESYNC_REQUIRED means main changed an export or schema your edits use; finish retries it like CHANNEL_CHANGED.\n';
  if (action === 'land')
    result +=
      'land records a desired state and returns a handle {operationId,entryIds} by default. wait:true watches that handle; disconnecting never cancels or drives it. landing {operationId} reads its current phase and outcome. An unbound owner service drives native work; hosted authority drives bound submissions after source preparation. A duplicate Lane/head returns the existing handle. Land selected recorded heads (unsaved edits remain untouched). Same-Intent inputs share a Candidate; compatible cross-Intent entries share a batch. Keep the operationId and replay the original request after a lost reply. Outcomes: accepted, failed, conflict, review-needed, waiting, preview-excluded. When integrationPreview.auto is enabled, exact saved inputs are previewed before checking. A new request with preview:"skip" overrides local preview exclusions.\n';
  if (action === 'confirm-tests')
    result +=
      'Confirm the proposed proving tests for a clean Candidate. Send candidateId, runId of a completed run on that exact source, expectedHead, expectedVersion and operationId. Optional tests replaces the proposed list. Complete measurements must total under 90000 ms. Missing timings and over-budget contracts are refused explicitly. The acceptance gate remains unchanged.\n';
  if (action === 'prioritize')
    result +=
      'Hosted owner command: prioritize {submissionId,priority:"urgent"|"normal"}. Reorders a queued Candidate; no running check is cancelled. Replay the same operationId after an unknown reply. urgent follows agentDefaults.urgentRoles (default owner only): agents on the owner\'s credential are refused unless the owner issues it with asOwner:true.\n';
  if (action === 'pin')
    result +=
      'Hosted owner command: x ROOT pin {laneId?,pinned?:true|false}. A pinned Lane is skipped by complete-merged, completeOnAccept, Intent cascade, prune and client cache GC, and an explicit complete or abandon refuses it (LANE_PINNED) until you unpin it with pinned:false. Reopen still works. Any state can be pinned, including a completed Lane. A repeat is a no-op.\n';
  if (action === 'abandon-dormant')
    result +=
      'Hosted owner command: x ROOT abandon-dormant {apply?:false,limit?:25}. A Lane is dormant after agentDefaults.dormantAfterDays (default 2) without a save, start, sync or landing; dormant Lanes are out of overlap, presence and board reads, and any save revives one. The default is a dry run: it lists dormant Lanes that can be abandoned (abandonable "landed": an accepted receipt landed the saved head; "empty": nothing was ever saved) and those kept (has-saved-work, pinned). apply:true abandons at most limit (25) per call and says how many remain; repeat until none. Saved heads are kept; reopen undoes it. Pinned Lanes are never touched.\n';
  if (action === 'ack')
    result +=
      'Hosted: ack {laneId?,choice?:"accept-order"|"swap"|"split",text?} answers every pending overlap notice on the Lane (stable answer ids, so a repeat replays). accept-order keeps your change and lands in order; split records that you routed around.\n';
  if (action === 'preflight')
    result +=
      "Hosted: preflight {laneId?,run?:true,budgetSeconds?,trim?,retry?} defaults to run:true, which builds and runs tests at once; look first with run:false (plan only: no build, no tests, no record) and read scope, tests, deferredTests and estimateMinutes. When the scope is full or near-full, run only your targeted test files and leave the rest to land --save, whose hosted check is the full run. It selects the saved head's affected tests with the landing check's selector, builds (build:core) and runs them here, and records the result in ROOT.forge-client. Local order is changed tests, explicit coverage and smoke, then tests that failed for these paths before, then direct tests (they run a changed module themselves, through a test fixture or through one module that imports it, or are named for it; these three are never trimmed), then hub consumers, recent landing failures within two modules, name-watch and two-module consumers; comment-only edits add only tests that read the file. The time budget (default 180 s, budgetSeconds) trims the ranked tiers and is a wall-time cap on the run: no file starts once it is spent, and the receipt names those in stopped with stoppedRerun (retry:true runs just them); plan and receipt name each skipped file and the one command that runs them (trim:false). Cut tests run in the pre-queue Lane check. The receipt reports wall time and peak RSS. run:false only plans (tests, estimateMinutes, command, local). After a sync or resolve the server has no saved path list for the head: the plan then compares the base and head States, drops paths already equal to current main, and reports changedPathsFrom manifests. Save first; land --save accepts a passing record for the same saved head.\n";
  if (action === 'source-pack')
    result +=
      'Hosted operator repair: x ROOT source-pack {} packs the current hosted main from this machine (objects come from the pack, the machine cache or object downloads) and publishes it to R2, so checks and Lane opens read one pack instead of every object. status current means the latest pack is already main; seed, cutover or import of a large repo should be followed by this.\n';
  if (action === 'tests')
    result +=
      'Read the scoped landing test selection for the Lane saved head versus current main. Returns scope, reason, tests, command and source pins; command is null when no test files are selected. Run it in the Lane after building. Checkpoint edits and ask again after sync or main changes. Includes contractProposal with per-file historical estimates (unknown timings are null), current contract and version. candidateId selects exact composed source; runId reads its complete measured timing reports. Read-only; no check is started.\n';
  if (action === 'status')
    result +=
      'laneId returns one compact Lane: state, saved head/base, save count, paged Candidates, last check, saved changed-path count and local peers advice. High region overlap also prints compact stderr lines; peers detail:true includes low/disjoint regions. detail:true also includes the existing owner overview. Omit laneId for that overview; intentId filters it. Candidate pages use offset/limit. Unsaved changes are available through review.\n';
  if (action === 'checkpoint' || action === 'sync')
    result +=
      'Top-level summary leads with the outcome. Existing result fields remain; detail:true expands peer details (also available with peers {laneId,detail:true}).\n';
  if (action === 'sync')
    result +=
      'Needs a checkpointed Lane (else LANE_DIRTY). Returns up-to-date, merged, or conflict with markers; resolve them and checkpoint or finish.\n';
  if (action === 'decide' || action === 'decisions')
    result +=
      'decide records who decided, what, why and when on target:{kind:"project"} or {kind:"intent",intentId}. overrides names a default (description, optional link) or decision (decisionId, optional link); supersedes:DECISION_ID retains the earlier decision with a replacement link. decidedAt optionally records a historical ISO date/time. actor/tool declare the entering agent; requester is the local caller. decisions omits target to list all records, including superseded ones. Records supply context; they do not change policy or authorization. Replay operationId and original inputs after an unknown reply.\n';
  if (action === 'report')
    result +=
      'Totals are cumulative for this Lane session (actor + optional sessionId); a new report replaces them. Advisory and local; nothing is verified.\n';
  if (action === 'planning' || action === 'put-planning-item' || action === 'comment-planning-item')
    result +=
      'Hosted backlog (Work > Planning). Every planning id (id, itemId, planningItemId) takes the full UUID or a unique hex prefix of 8+ characters, resolved in the same call (an ambiguous prefix lists up to 5 candidates). search matches title/body by indexed relevance, active by default; status:all includes closed work. Search is read-only. New Issues/friction return advisory likelyDuplicates. planning {search?,id?,kind?,status?,initiativeId?,limit?,cursor?,reconcile?} reads one indexed page, or one item with comments; reconcile (default true) closes Issues whose Intent finished and reports it. put-planning-item changes the fields it names at expectedVersion (0 creates and needs kind+title; omit itemId to create); an omitted field keeps its stored value, so a status move is {itemId,expectedVersion,status}; clear with body:"", intentIds:[], initiativeId:null; search accepts an item id (8 characters or full UUID) and lists that item first; comment-planning-item adds a comment. Writes need the project owner; replay operationId after an unknown reply. start planningItemId starts an Issue (an open Issue whose Intent landed continues on a follow-up Intent; a closed Issue is refused with the reopen command).\n';
  if (action === 'start')
    result +=
      'intentId adds a Lane to an open Intent; after declares a landing dependency. Default uses accepted main when present; channel:null explicitly selects workspace source.\n';
  if (
    [
      'start',
      'open',
      'save',
      'checkpoint',
      'compose',
      'sync',
      'resolve',
      'check',
      'run',
      'finish',
      'cancel',
      'revert',
      'abandon',
      'reopen',
      'status',
      'observe',
      'capabilities',
      'tests',
      'confirm-tests',
      'prioritize',
      'pin',
      'configure-check',
      'configure-runner',
      'check-settings',
    ].includes(action)
  )
    result +=
      'Hosted projects use the same action with url + projectId, or the address retained by a hosted checkout. See docs/operations/source-exchange.md (Hosted agent CLI) for hosted fields and finite progress reads.\n';
  return result;
}
/** laneId from a cwd inside `<work directory>/lane-<uuid>`. */
function laneFromCwd(directory: string): string | undefined {
  let cwd: string;
  try {
    cwd = realpathSync(process.cwd());
  } catch {
    return undefined;
  }
  const prefix = `${directory}${sep}lane-`;
  if (!cwd.startsWith(prefix)) return undefined;
  const id = cwd.slice(prefix.length).split(sep)[0]!;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ? id : undefined;
}

/** process: invoked as the nforge process (land detaches its submission and waits by default). */
type AgentCliOptions = {
  operator?: boolean;
  notices?: boolean;
  process?: boolean;
  beforeDispatch?: (input?: { stdin?: string }) => Promise<boolean>;
  beforeLocal?: () => Promise<void>;
};

/** Client-side flags, accepted anywhere after the action: --wait/--no-wait and --message-file FILE|-. */
function clientOptions(tail: string[]) {
  const rest: string[] = [];
  let wait: boolean | undefined, messageFile: string | undefined, budget: number | undefined;
  for (let index = 0; index < tail.length; index++) {
    const arg = tail[index]!;
    if (arg === '--budget') {
      budget = parseWaitBudget(tail[index + 1]);
      invariant(
        budget !== undefined,
        'BAD_ARGUMENT',
        'Use --budget SECONDS once (or 90s, 9m); it bounds how long wait or land --save blocks before IN_PROGRESS.',
      );
      index++;
    } else if (arg === '--wait' || arg === '--no-wait') {
      invariant(wait === undefined, 'BAD_ARGUMENT', 'Choose --wait or --no-wait once.');
      wait = arg === '--wait';
    } else if (arg === '--message-file') {
      invariant(
        messageFile === undefined && tail[index + 1] !== undefined,
        'BAD_ARGUMENT',
        'Use --message-file FILE once (- reads stdin).',
      );
      messageFile = tail[++index];
    } else if (arg !== '--detail') rest.push(arg); // --detail: print the full receipt (handled where it prints)
  }
  return { rest, wait, messageFile, budget };
}
function readInput(path: string, name: string): string {
  try {
    return readFileSync(path === '-' ? 0 : path, 'utf8');
  } catch {
    invariant(false, 'BAD_ARGUMENT', `${name} could not be read.`);
  }
}

/** Alias notices print only after the command succeeds, so error stderr stays one JSON object. */
export async function agentCli(args: string[], options: AgentCliOptions = {}): Promise<unknown> {
  const notices: string[] = [];
  const result = await runAgentCli(args, options, notices);
  for (const notice of notices) process.stderr.write(notice);
  const pending = (
    result as
      | {
          result?: {
            inProgress?: boolean;
            waitCommand?: string;
            next?: Record<string, unknown>;
            wake?: unknown;
          };
        }
      | undefined
  )?.result;
  // The land submitter already printed this command in its announcement line; repeating it costs context.
  if (
    options.process &&
    args[1] !== 'wait' &&
    pending?.inProgress &&
    pending.waitCommand &&
    !pending.wake &&
    process.env[LAND_CHILD_ENV] !== '1'
  )
    process.stderr.write(`Forge work is unfinished; keep this turn active and run: ${pending.waitCommand}\n`);
  // Unfinished work this agent session owns, for its turn-end hook (one local write).
  if (options.process && pending?.inProgress && args[0] && ['land', 'finish', 'wait'].includes(args[1] ?? ''))
    recordTurnWait(resolve(args[0]), pending.next, null);
  return result;
}

async function runAgentCli(args: string[], options: AgentCliOptions, notices: string[]): Promise<unknown> {
  let stdin: string | undefined;
  const read = (path: string, name: string) => {
    const value = readInput(path, name);
    if (path === '-' && stdin === undefined) stdin = value;
    return value;
  };
  if (!args.length || args[0] === '--help' || args[0] === 'help') {
    await options.beforeLocal?.();
    process.stdout.write(AGENT_HELP);
    return undefined;
  }
  const textMode = args[1] === 'wait' && args.includes('--text');
  if (textMode) args = args.filter(arg => arg !== '--text');
  if (args[1] === 'peers' && args[2] === '--path' && args[3]) {
    const workflow = await nativeWorkflow(args[0]!);
    const laneId = laneFromCwd(workflow.work.store.directory) ?? process.env.FORGE_LANE_ID;
    invariant(laneId, 'BAD_ARGUMENT', 'Run peers --path inside a Lane or set FORGE_LANE_ID.');
    return workflow.dispatch({ action: 'peers', laneId, path: args[3] });
  }
  const [root, requestedAction, ...rawTail] = args;
  const client = clientOptions(rawTail),
    tail = client.rest;
  if (requestedAction === 'help' || requestedAction === '--help') {
    await options.beforeLocal?.();
    process.stdout.write(hostedAgentAddress(root!, {}) ? hostedAgentHelp() : AGENT_HELP);
    return undefined;
  }
  if (requestedAction) noticeViewAlias(requestedAction);
  const [form, rest] = requestedAction
    ? parseVerbForm(requestedAction, tail, options.operator)
    : [undefined, tail];
  const [option, path] = rest;
  const canonical = (value: string) => (value === 'save' ? 'checkpoint' : canonicalCandidateAction(value));
  let action = form ? canonical(lowerVerb(form, false)) : undefined;
  invariant(
    root && action && (rest.length <= 1 || (rest.length === 2 && option === '--command-file')),
    'BAD_ARGUMENT',
    'Use agent ROOT ACTION [JSON | --command-file FILE]. Operator actions (x ACTION, e.g. friction-triage) run as nforge x ROOT ACTION [JSON | --command-file FILE].',
  );
  if (option === '--help') {
    await options.beforeLocal?.();
    if (action === 'install-hooks' || action === 'uninstall-hooks') {
      process.stdout.write(
        'Local first-write hooks: {scope?:"user"|"project",laneId?:"legacy ignored"}. Lane-independent; first CLI run installs by default. Uninstall persists off; undo with install-hooks. User switch: nforge settings firstWriteHooks false.\n',
      );
      return undefined;
    }
    process.stdout.write(
      hostedAgentAddress(root, {})
        ? hostedAgentHelp(lowerVerb(form!, true))
        : actionHelp(action === 'view' ? 'candidate' : action === 'views' ? 'candidates' : action),
    );
    return undefined;
  }
  let text = option ?? '{}';
  if (option === '--command-file') {
    invariant(path, 'BAD_ARGUMENT', 'Choose a command JSON file, or - for stdin.');
    text = read(path, 'Command file');
  }
  let parameters: unknown;
  try {
    parameters = JSON.parse(text);
  } catch {
    invariant(false, 'BAD_ARGUMENT', 'Command parameters must be JSON.');
  }
  invariant(
    parameters && typeof parameters === 'object' && !Array.isArray(parameters),
    'BAD_ARGUMENT',
    'Command parameters must be a JSON object.',
  );
  let selected = parameters as Record<string, unknown>;
  if (client.budget !== undefined) {
    invariant(
      action === 'wait' || action === 'finish',
      'BAD_ARGUMENT',
      '--budget applies to wait and land --save.',
    );
    // land --save keeps its budget client-side: the finish request itself never carries a deadline.
    if (action === 'wait') selected = { ...selected, timeoutSeconds: client.budget };
  }
  // Any message text (apostrophes, newlines) arrives verbatim from a file or stdin, never through shell quoting.
  if (client.messageFile !== undefined)
    selected = {
      ...selected,
      message: read(client.messageFile, 'Message file').replace(/\r?\n$/, ''),
    };
  if (typeof selected.action === 'string') noticeViewAlias(selected.action);
  if (action === 'install-hooks' || action === 'uninstall-hooks') {
    if (
      options.beforeDispatch &&
      !(await options.beforeDispatch(stdin === undefined ? undefined : { stdin }))
    )
      return;
    const { configureEditHooks } = await import('./agent-install-hooks.js');
    return configureEditHooks(resolve(root), selected, action === 'uninstall-hooks');
  }
  const hosted = hostedAgentAddress(root, selected);
  action = canonical(lowerVerb(form!, Boolean(hosted)));
  if (action === 'history') {
    invariant(
      hosted,
      'HISTORY_HOSTED_ONLY',
      "history reads a hosted project's imported Git history; run it in a hosted checkout or Lane.",
    );
    if (
      options.beforeDispatch &&
      !(await options.beforeDispatch(stdin === undefined ? undefined : { stdin }))
    )
      return;
    return await (await import('./hosted-history-output.js')).hostedHistoryCli(root, selected, hosted);
  }
  if (action === 'log' && hosted) {
    if (
      options.beforeDispatch &&
      !(await options.beforeDispatch(stdin === undefined ? undefined : { stdin }))
    )
      return;
    return await (await import('./hosted-check-log-output.js')).hostedCheckLogCli(root, selected, hosted);
  }
  invariant(
    selected.action === undefined ||
      (typeof selected.action === 'string' && canonical(selected.action) === action),
    'BAD_ARGUMENT',
    'Command action differs from the selected action.',
  );
  // Old spellings print their start/save/land or x form once; new forms and internal facades stay quiet.
  const notice = (command: Record<string, unknown>) => {
    if (
      options.notices === false ||
      form!.operator ||
      form!.flags.length ||
      process.env[LAND_CHILD_ENV] === '1'
    )
      return;
    const current = newForm(requestedAction!, command, Boolean(hosted));
    if (current) notices.push(aliasNotice(root, requestedAction!, current));
  };
  if (hosted) {
    // A unique short laneId of a Lane this machine opened resolves locally (no network).
    const short = resolveShortLaneId(selected, hosted.projectId);
    if (short.resolved) {
      process.stderr.write(`laneId ${String(selected.laneId)} resolved to ${short.resolved}\n`);
      selected = short.selected;
    }
    const command = canonicalOperationIds(root, landSaveCommand(form!, true, selected));
    try {
      // The hosted command modules load while the release check (and, for commands that start with
      // it, capability discovery) is on the network, not before it (fea47345 round 3).
      const modules = Promise.all([
        import('./hosted-agent-cli.js'),
        import('./hosted-land-cli.js'),
        import('./hosted-agent-transport.js'),
      ]);
      modules.catch(() => undefined);
      if (options.beforeDispatch) {
        validateHostedCliCommand(root, action, command);
        if (discoversCapabilitiesFirst(hostedAgentRoot(root), action, command))
          startEarlyCapabilities(hostedAgentRoot(root), hosted);
        if (!(await options.beforeDispatch(stdin === undefined ? undefined : { stdin }))) return;
      }
      const [{ hostedAgentCli }, { hostedLandCli }, { HostedAgentTransport }] = await modules;
      notice(selected);
      // The installed CLI detaches the submission and waits by default; in-process callers opt in.
      if (action === 'finish' && (options.process || client.wait !== undefined))
        return await hostedLandCli(root, command, hosted, {
          wait: client.wait ?? (options.process ? undefined : false),
          detach: Boolean(options.process),
          ...(client.budget !== undefined ? { timeoutSeconds: client.budget } : {}),
        });
      if (action === 'show') {
        await (await import('./hosted-show-cli.js')).hostedShowCli(root, command, hosted);
        return undefined;
      }
      if (action !== 'start' || !options.process) return await hostedAgentCli(root, action, command, hosted);
      const transport = new HostedAgentTransport(root, hosted);
      // The Lane id and path print before the checkout downloads, so a slow open never hides them.
      transport.onStarted = lane => process.stderr.write(`${JSON.stringify({ started: lane })}\n`);
      const response = (await hostedAgentCli(root, action, command, hosted, transport)) as {
        localLanes?: {
          idle: IdleLane[];
          otherRuns?: OtherRunLane[];
          pruned: { count: number; bytes: number };
        };
      };
      // A bounded step that stalled is still pending: once the reply is out, do not wait for it.
      if (transport.abandonedStart) setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref();
      if (response.localLanes)
        for (const line of housekeepingLines(
          root,
          response.localLanes.idle,
          response.localLanes.pruned,
          true,
          response.localLanes.otherRuns,
        ))
          process.stderr.write(`${line}\n`);
      return response;
    } catch (error) {
      throw actionableNotFound(error, action, command);
    }
  }
  invariant(
    action !== 'withdraw',
    'HOSTED_ACTION_UNSUPPORTED',
    'land --withdraw ends a hosted landing. Native checks stop with nforge x ROOT cancel {operationId:CHECK_RUN_ID}.',
  );
  invariant(
    client.wait === undefined || action === 'finish',
    'BAD_ARGUMENT',
    '--wait and --no-wait apply to land --save.',
  );
  // Native finish already waits by default; --no-wait returns after durable submission.
  if (action === 'finish' && client.wait === false) selected = { ...selected, wait: false };
  const nativeRoot = requireAgentRoot(root);
  if (options.beforeDispatch && action === 'friction') validateNativeFrictionCommand(selected);
  if (options.beforeDispatch && !(await options.beforeDispatch(stdin === undefined ? undefined : { stdin })))
    return;
  if (action === 'wait') {
    await (await import('./agent-wait.js')).agentWaitCli(nativeRoot, selected, textMode);
    return undefined;
  }
  const agent = await nativeWorkflow(nativeRoot);
  const retained =
    action === 'finish' && typeof selected.operationId === 'string'
      ? (await import('./agent-finish-journal.js')).retainedFinishCommand(
          agent.work.store,
          selected.operationId,
        )
      : undefined;
  notice({ ...retained, ...selected });
  selected = landSaveCommand(form!, false, selected, retained);
  if (action === 'integrate')
    return (await import('./integration-preview.js')).integrationPreview(agent.work.store, selected);
  if (
    ['checkpoint', 'sync', 'finish', 'handoff', 'handoff-read', 'friction'].includes(action) &&
    selected.laneId === undefined &&
    retained?.laneId === undefined
  ) {
    const laneId = laneFromCwd(agent.work.store.directory);
    if (laneId) selected.laneId = laneId;
  }
  const response = await agent.dispatch({ ...retained, ...selected, action });
  if (action === 'land' && selected.wait === true) {
    const landing = response.result as { complete: boolean; table: string };
    process.stderr.write(landing.table + '\n');
    if (!landing.complete) process.exitCode = 1;
  }
  const result = response.result as {
    peers?: { predictive?: PredictiveOverlap[]; inbox?: { text: string }[] };
    predictive?: PredictiveOverlap[];
  };
  const predictions = action === 'peers' ? result.predictive : result.peers?.predictive;
  for (const notice of result.peers?.inbox ?? [])
    process.stderr.write(`${notice.text.replace(/[\x00-\x1f\x7f]/g, ' ')}\n`);
  const { overlapLines } = await import('./agent-predictive-overlap.js');
  for (const line of overlapLines(predictions ?? [])) process.stderr.write(`${line}\n`);
  if (action === 'show') {
    const overlaps = callerOverlaps(root, typeof selected.laneId === 'string' ? selected.laneId : undefined);
    if (overlaps) process.stderr.write(JSON.stringify({ unacknowledgedOverlaps: overlaps }) + '\n');
    const file = response.result as ReturnType<
      typeof import('./agent-source-read.js').readAgentShow
    >['result'];
    process.stdout.write(Buffer.from(file.content, file.encoding));
    return undefined;
  }
  return action === 'brief' ? response.result : response;
}
