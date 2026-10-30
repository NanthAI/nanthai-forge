import { callerOverlaps } from './agent-caller-overlaps.js';
import { hostedAgentAddress, hostedAgentCli } from './hosted-agent-cli.js';
import { agentWaitCli } from './agent-wait.js';
import { canonicalCandidateAction, noticeViewAlias } from './candidate-names.js';
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { integrationPreview } from './integration-preview.js';
import { AgentWorkflow } from './agent-workflow.js';
import { overlapLines, type PredictiveOverlap } from './agent-predictive-overlap.js';
import { retainedFinishCommand } from './agent-finish-journal.js';
import { invariant } from './errors.js';

export const AGENT_HELP = `Forge agent workflow
  nforge agent ROOT ACTION [JSON | --command-file FILE]
  nforge agent ROOT ACTION --help
  nforge mcp ROOT --agent

Typical loop:
  nforge agent ROOT start '{"outcome":"Fix the login bug"}'
  (edit files in the returned path)
  nforge agent ROOT finish '{"laneId":"LANE_ID","message":"Fix login","accept":true}'

finish checkpoints, syncs the Lane with main if main moved, composes, runs the
"verify" check (or the only check) and requests acceptance under project policy.
CHANNEL_CHANGED retries use a per-Channel landing queue (maxRetries defaults to 3);
receipts list all attempts and waiting positions.
New supervised projects stop at awaiting-review; a person accepts their checked Candidate.
policy reads settings; set-policy selects a preset or edits fields (custom).
laneUpdates:ask stops at sync-required when main moved; native undo-sync restores
a recorded pre-sync checkpoint and refuses newer edits unless force:true.
start/checkpoint/sync/finish and Lane status include a local peers digest; scope:{paths:["src/file.ts"]}
declares paths; start retains planned claims until the Lane closes.
take {laneId,takeover:true} hands another actor’s Lane to you with its context. peers {laneId,detail:true} reads full details.
save is an alias of checkpoint, with the same pins and replay identity.
Clean checkpoints succeed with the unchanged head.
friction captures workflow cost in owner Work; improve groups it; friction-triage records a decision.
start/finish frictionIds:[ID] links a fixing Lane and closes reports when it lands.
sync brings main into a Lane like git pull; resolve any conflict markers, then
finish again. Inside a Lane directory laneId may be omitted.

Omitted operationId and pins are filled from current state and returned under
"resolved". After an unknown reply, retry with your request plus "resolved".
Once finish has checkpointed, resume its retained request with:
  nforge agent ROOT finish '{"operationId":"ORIGINAL_FINISH_UUID"}'
Use the parent finish operationId, not an attempt's child operation ID.

Hosted addressing: pass {url,projectId,...} on this same command surface, or use
a hosted Lane checkout ROOT. No native owner/listener is needed. Read capabilities
and use status/observe for finite reads. Hosted checkpoint/save and run/check are aliases.
Hosted also supports open, save, check, resolve, revert and capabilities.
Hosted sync {candidateId} opens an exact conflict draft. Edit its files, call resolve
in the returned root, then finish there; a clean saved resolution needs no fake edit.
Hosted finish prepares conflict files automatically; pending source work stays durable.
Hosted owners configure checks with configure-check, configure-runner and check-settings.
Hosted commands retain generated UUIDs and exact pins in ROOT.forge-client/agent;
retry identical parameters after a lost reply. A new explicit operationId starts new work.
Hosted start returns Lane pins; open materializes it; finish saves an opened Lane,
composes and submits durable agent landing. Pending is not accepted.

Actions: integrate, wait, handoff, handoff-read, tests, peers, peer-ack, link, take, start, land, landing, land-ready, checkpoint, save, sync, undo-sync, policy, set-policy, finish, compose, define-check, run, observe,
         log, cancel, accept, complete, abandon, reopen, complete-merged, clean, status, records, candidate, provenance, candidates, review, diff, show, brief, guidance,
         making-of, report, metrics, friction, friction-triage, improve, decide, decisions.
start stackOn:LANE_ID bases a native Lane on that parent’s latest saved head and waits for its landing.
sync restacks onto the latest parent; after landing it targets main. ontoMain:true detaches explicitly.
status/peers/pending show the chain, parent movement and abandonment.
start intentId adds a sibling Lane; finish with:[laneId] uses saved siblings and orders high overlaps when accepting.
after:{intentId} or after:{viewId} waits for that work to land; land-ready resumes waits.
finish/accept complete included Lanes; the Intent completes when all its Lanes are done (keepOpen:true to opt out).
Lanes show merged:true when their head is already in a Channel; complete-merged
completes those. clean is a dry run until apply:true. run needs only {"laneId"}; log accepts tail:BYTES, shard:N (or "static"), and attempt:N (default 1).
start records actor:"agent-name" (or FORGE_AGENT_NAME, then FORGE_ACTOR).
Use distinct names in concurrent shells; tool optionally names the agent tool.
making-of reads one Intent's derived record (Lanes, saves, runs with queue/run time,
landings, sessions); report records self-reported harness, model and token totals.
candidate and candidates read pinned results; view and views are deprecated aliases (stderr notice only).
JSON fields (viewId, views) and Work formats are unchanged.
Read the packaged agent skill: nforge docs agent.
`;

const examples: Record<string, unknown> = {
  capabilities: { url: 'https://deployment.convex.cloud', projectId: 'PROJECT_ID' },
  open: { laneId: 'LANE_ID', paths: ['src'] },
  save: { laneId: 'LANE_ID', message: 'Save edits' },
  resolve: { laneId: 'RESOLUTION_LANE_ID', message: 'Resolve conflict' },
  check: { candidateId: 'CANDIDATE_ID', checkId: 'CHECK_ID' },
  revert: { target: { kind: 'receipt', receiptId: 'RECEIPT_ID' }, message: 'Revert acceptance' },
  handoff: {
    laneId: 'LANE_ID',
    summary: 'What changed and why',
    tests: [{ command: 'node --test tests/example.test.mjs', passed: 3, failed: 0, skipped: 0 }],
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
  'friction-triage': { frictionIds: ['FRICTION_ID'], status: 'planned', reason: 'Next check-runner slice' },
  improve: {},
  metrics: { from: '2026-10-14', to: '2026-10-26' },
  decide: {
    target: { kind: 'intent', intentId: 'INTENT_ID' },
    decidedBy: 'Owner',
    what: 'Use the contract check',
    why: 'Keep the landing loop short',
    overrides: { kind: 'default', description: 'Full-suite landing gate', link: 'docs/workflows.md' },
  },
  decisions: { target: { kind: 'project' } },
  wait: { laneIds: ['LANE_ID'], operationIds: [], until: 'terminal', timeoutSeconds: 600 },
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
  'install-hooks': { laneId: 'LANE_ID' },
  'uninstall-hooks': { laneId: 'LANE_ID' },
  peers: { laneId: 'LANE_ID', detail: true },
  'peer-ack': { laneId: 'LANE_ID', noticeId: 'NOTICE_ID', choice: 'accept-order' },
  take: { laneId: 'LANE_ID', takeover: true },
  link: { laneId: 'LANE_ID', path: 'src/file.ts', line: 42 },
  candidate: { viewId: 'CANDIDATE_ID', offset: 0, limit: 20 },
  provenance: { viewId: 'CANDIDATE_ID', file: 'src/file.ts', lines: true, offset: 0, limit: 20 },
  candidates: { laneId: 'LANE_ID', offset: 0, limit: 20 },
  brief: { situation: 'continue-lane', laneId: 'LANE_ID', agent: 'generic' },
  policy: {},
  'set-policy': { operationId: 'UUID', preset: 'trusted' },
  'undo-sync': { laneId: 'LANE_ID', syncOperationId: 'SYNC_UUID' },
  guidance: { operationId: 'UUID', scope: 'project', agentGuidance: 'How agents should work' },
  'land-ready': {},
  start: { outcome: 'Describe the intended change' },
  landing: { operationId: 'UUID' },
  land: { operationId: 'UUID', laneIds: ['LANE_ID', 'OTHER_LANE_ID'] },
  checkpoint: { laneId: 'LANE_ID', message: 'Describe the checkpoint' },
  sync: { laneId: 'LANE_ID' },
  compose: { operationId: 'UUID', intentId: 'INTENT_ID', inputs: [{ laneId: 'LANE_ID', head: 'HEAD' }] },
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
  cancel: { operationId: 'ORIGINAL_UUID' },
  accept: { viewId: 'CANDIDATE_ID' },
  complete: { laneId: 'LANE_ID' },
  abandon: { laneId: 'LANE_ID', reason: 'Superseded by accepted work', saveFirst: true },
  reopen: { laneId: 'LANE_ID' },
  'complete-merged': { channel: 'main' },
  clean: { apply: false, kinds: ['check-workspaces', 'lane-deps', 'lanes'] },
  status: { laneId: 'LANE_ID' },
  records: { collection: 'lanes', state: 'active', merged: false, offset: 0, limit: 50 },
  'making-of': { intentId: 'INTENT_ID' },
  report: { laneId: 'LANE_ID', harness: 'claude-code', model: 'MODEL', tokens: { input: 1200, output: 340 } },
  diff: { laneId: 'LANE_ID', paths: ['src/file.ts'] },
  show: { state: 'STATE', path: 'src/file.ts' },
  review: { kind: 'lane', id: 'LANE_ID', expectedHead: 'HEAD', paths: ['src/file.ts'] },
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
  accept: { operationId: 'UUID', viewId: 'CANDIDATE_ID', expectedHead: 'HEAD', expectedPrevious: null },
  'configure-check': { name: 'verify' },
  'configure-runner': { provider: 'self-hosted' },
  'check-settings': {},
};
function actionHelp(action: string): string {
  invariant(action in examples, 'BAD_ARGUMENT', 'Unknown agent action. Use agent --help.');
  let result = `nforge agent ROOT ${action} '${JSON.stringify(examples[action])}'\n`;
  if (strict[action]) result += `Fully pinned: '${JSON.stringify(strict[action])}'\n`;
  if (action === 'start' || action === 'sync')
    result +=
      'start stackOn:LANE_ID uses the parent’s saved head; sync restacks onto its latest save, or main after its receipt. sync ontoMain:true detaches and reapplies only the child delta. Resolve conflicts then checkpoint. Child finish/land waits for the parent; land-ready resumes waiting finishes.\n';
  if (action === 'configure-check' || action === 'configure-runner' || action === 'check-settings')
    result +=
      'Hosted project owner only. configure-check imports the named check (default verify) from hosted Work, checkId selects one by id, or command:{name,executable,args,environmentLabel} defines one. configure-runner provider:"self-hosted" (legacy alias "mac") fills machineId (kept from the current machine runner), runtime, platform and environment from this package and process; optional labels:["linux","build"] describe routing to this machine, so run it in the worker\'s exact environment; provider:"github-actions" with repository:"OWNER/NAME" and optional runsOn:"LABEL" or runsOn:["self-hosted","linux","x64"] (default ubuntu-latest) selects the Convex-dispatched GitHub Actions runner (the server derives runtime and environment and checks the App installation and its Actions permission; no installation ID or secret); configuration:{...} sets another provider. expected pins the current digest (default: read now; null for none). Identical parameters replay their first result; pass a new operationId to change again. check-settings is read-only and lists blockers.\n';
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
      'Select exactly one state (full digest) or laneId (saved head), plus a relative file path. Writes exact bytes to stdout without JSON or an added newline. Binary/invalid UTF-8 or files over 1 MiB require force:true. MCP returns source pins and content with encoding utf8 or base64.\n';
  if (action === 'link')
    result +=
      'Select exactly one laneId, viewId or save (full source digest). path is an optional relative source file; line requires path. Links target the hosted app; an unpublished head may be unavailable until source is pushed.\n';
  if (action === 'run')
    result +=
      'Optional tests:["tests/example.test.mjs"] replaces only the standard check test selection. Static checks still run. Explicit lists (including []) are partial evidence and cannot satisfy a landing gate or check reuse.\n';
  if (action === 'observe' || action === 'log' || action === 'cancel')
    result +=
      'operationId is the nested check run operation ID, not the finish operation ID. Resume a finish by replaying its original finish request plus resolved pins.\n';
  if (action === 'cancel')
    result +=
      'Hosted cancel takes {submissionId,operationId?}: submissionId selects a landing request and operationId identifies this cancellation. An already accepted request returns its receipt; Lane lifecycle stays independent; an unneeded hosted check is cancelled when its last live submission leaves.\n';
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
      'Hosted owner command: prioritize {submissionId,priority:"urgent"|"normal"}. Reorders a queued Candidate; no running check is cancelled. Replay the same operationId after an unknown reply.\n';
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

export async function agentCli(args: string[]): Promise<unknown> {
  if (!args.length || args[0] === '--help' || args[0] === 'help') {
    process.stdout.write(AGENT_HELP);
    return undefined;
  }
  const textMode = args[1] === 'wait' && args.includes('--text');
  if (textMode) args = args.filter(arg => arg !== '--text');
  if (args[1] === 'peers' && args[2] === '--path' && args[3]) {
    const workflow = new AgentWorkflow(args[0]!);
    const laneId = laneFromCwd(workflow.work.store.directory) ?? process.env.FORGE_LANE_ID;
    invariant(laneId, 'BAD_ARGUMENT', 'Run peers --path inside a Lane or set FORGE_LANE_ID.');
    return workflow.dispatch({ action: 'peers', laneId, path: args[3] });
  }
  const [root, requestedAction, option, path] = args;
  if (requestedAction) noticeViewAlias(requestedAction);
  const canonical = (value: string) => (value === 'save' ? 'checkpoint' : canonicalCandidateAction(value));
  const action = requestedAction ? canonical(requestedAction) : undefined;
  if (action === 'help' || action === '--help') {
    process.stdout.write(AGENT_HELP);
    return undefined;
  }
  invariant(
    root &&
      action &&
      (args.length === 2 || args.length === 3 || (args.length === 4 && option === '--command-file')),
    'BAD_ARGUMENT',
    'Use agent ROOT ACTION [JSON | --command-file FILE].',
  );
  if (option === '--help') {
    process.stdout.write(
      actionHelp(action === 'view' ? 'candidate' : action === 'views' ? 'candidates' : action),
    );
    return undefined;
  }
  let text = option ?? '{}';
  if (option === '--command-file') {
    invariant(path, 'BAD_ARGUMENT', 'Choose a command JSON file.');
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      invariant(false, 'BAD_ARGUMENT', 'Command file could not be read.');
    }
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
  const selected = parameters as Record<string, unknown>;
  if (typeof selected.action === 'string') noticeViewAlias(selected.action);
  invariant(
    selected.action === undefined ||
      (typeof selected.action === 'string' && canonical(selected.action) === action),
    'BAD_ARGUMENT',
    'Command action differs from the selected action.',
  );
  const hosted = hostedAgentAddress(root, selected);
  if (hosted) return hostedAgentCli(root, action, selected, hosted);
  if (action === 'wait') {
    await agentWaitCli(root, selected, textMode);
    return undefined;
  }
  const agent = new AgentWorkflow(root);
  if (action === 'integrate') return integrationPreview(agent.work.store, selected);
  const retained =
    action === 'finish' && typeof selected.operationId === 'string'
      ? retainedFinishCommand(agent.work.store, selected.operationId)
      : undefined;
  if (
    ['checkpoint', 'sync', 'finish', 'handoff', 'handoff-read'].includes(action) &&
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
