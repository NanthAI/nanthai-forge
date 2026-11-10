// SPDX-License-Identifier: Apache-2.0
import { recoverLocalApply } from './hosted-apply-recovery.js';
import { commandScopeProposal } from './check-command-scope.js';
import { retainSyncHandoff, clearSyncHandoff } from './hosted-sync-handoff.js';
import { guideHostedSync, resolveHostedAgent } from './hosted-agent-resolution.js';
import { syncTiming, type StepTimer } from './sync-timing.js';
import { hostedRecordSchema } from './hosted-records.js';
import { executeHostedFinish } from './hosted-agent-finish.js';
import { executeHostedWithdraw } from './hosted-agent-withdraw.js';
import { settleTurnWork } from './agent-turn-work.js';
import { executeHostedMetrics } from './hosted-agent-metrics.js';
import { isMachineRunner, machineRunnerDescription } from './hosted-machine-runner.js';
import { checkLogsField, publicLogsNotice } from './runner-visibility.js';
import { mergeSubmoduleAllowlist, submoduleAllowSchema } from './submodule-allowlist.js';
import { z } from 'zod';
import { githubActionsRunsOnSchema, githubActionsRunnerDescription } from './github-actions-runner-label.js';
import { makeFunctionReference } from 'convex/server';
import { hostedAgentCommandSchemas, type HostedAgentAction } from './hosted-agent-contract.js';
import { hostedStartSchema, hostedStartResultSchema } from './hosted-lane.js';
import { checkoutHostedLane } from './hosted-lane-checkout.js';
import { adoptNestedLaneCopy } from './hosted-lane-adopt.js';
import { checkoutRequired, openLaneRoot, SELECT_LANE } from './hosted-lane-location.js';
import { ConvexLaneTransport } from './hosted-lane-transport.js';
import {
  applyObservedSaveOutcome,
  saveContract,
  saveHostedLane,
  settlePriorHostedSave,
} from './hosted-save-client.js';
import { capturedNotSaved } from './save-not-saved.js';
import { saveSettledHere, unsavedAfterSave } from './hosted-save-receipt-state.js';
import { transitionHostedLane } from './hosted-lifecycle-client.js';
import { lifecycleApplied, recordLifecycleApplied } from './hosted-replay-holds.js';
import { hostedLifecycleRequestSchema } from './hosted-lifecycle.js';
import { randomUUID } from 'node:crypto';
import { sep } from 'node:path';
import { hostedCheckRequestSchema, hostedSelfHostedRunnerSchema } from './hosted-check.js';
import { hostedMacRuntime } from './hosted-mac-lease.js';
import { checkEnvironment } from './check-environment.js';
import { autonomyPolicySchema, reviewReason } from './autonomy-policy.js';
import type { HostedAgentCapabilities } from './hosted-agent-contract.js';
import { hostedLandingCancelSchema } from './hosted-landing.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { syncRequestSchema, syncResultSchema } from './hosted-sync.js';
import { applyHostedSync } from './hosted-sync-client.js';
import { markerAt, retainedLocalApplyBlocked } from './hosted-apply-recovery-records.js';
import { MainPinRefused, mainPinRefusal, sendMainPinned } from './hosted-main-pin.js';
import {
  composeAgentSource,
  driveAgentSource,
  syncAgentSource,
  selectAgentLane,
  SyncPinsStale,
} from './hosted-agent-source.js';
import { invariant } from './errors.js';
import { plannedIntent } from './hosted-agent-planning.js';
import { unadvertisedActionError } from './hosted-agent-version.js';
import { hostedActionError } from './hosted-action-error.js';
import { autoStackPeer } from './hosted-coordination-client.js';
import { completeMergedLanes } from './hosted-agent-complete.js';
import { abandonDormantLanes } from './hosted-agent-dormant.js';
import { recordLane, readLaneEntry } from './lane-registry.js';
import { saveExpectedSchema } from './hosted-save.js';
import type { HostedAgentSession } from './hosted-agent-transport.js';
import { parseHostedResponse } from './hosted-response.js';
const pinResultSchema = z
  .object({
    laneId: z.uuid(),
    pinned: z.boolean(),
    state: z.enum(['active', 'completed', 'abandoned']),
    changed: z.boolean(),
    version: z.number(),
  })
  .strict();
const outcome = z.object({ outcome: z.object({ status: z.string(), result: z.unknown().optional() }) });
export function agentSourceOutcome(value: unknown) {
  const parsed = outcome.safeParse(value);
  return parsed.success ? parsed.data.outcome : null;
}
/** The journal key holding the public-logs notice of the runner a check was selected on. */
export const checkLogsKey = 'check-logs';
/** The journal key holding the landing-mode advice of the project (src/landing-mode.ts), when it should switch. */
export const landingAdviceKey = 'landing-advice';
/** The advice the server derived for `check-settings` (`mainAudit.landing`): its next step when the
 * project should switch landing mode, else null. Read from a reply the caller already has. */
export function landingAdvice(mainAudit: unknown): string | null {
  const parsed = z
    .object({ landing: z.object({ advice: z.object({}).loose().nullable(), nextStep: z.string() }).loose() })
    .loose()
    .safeParse(mainAudit);
  return parsed.success && parsed.data.landing.advice ? parsed.data.landing.nextStep.slice(0, 800) : null;
}
export async function checkSelection(
  session: HostedAgentSession,
  command: z.infer<typeof hostedAgentCommandSchemas.finish>['check'],
) {
  if (!command) {
    let cursor: string | null = null;
    const found: { id: string; name: string }[] = [];
    do {
      const page: {
        page: { check: { id: string; name: string } }[];
        isDone: boolean;
        continueCursor: string;
      } = await session.query('projectHostedCheckDefinitions:list', { cursor });
      found.push(...page.page.map(row => row.check));
      const verify = found.find(check => check.name === 'verify');
      if (verify) {
        command = { checkId: verify.id };
        break;
      }
      cursor = page.isDone ? null : page.continueCursor;
    } while (cursor !== null);
    if (!command && found.length === 1) command = { checkId: found[0]!.id };
    invariant(
      command,
      'BAD_ARGUMENT',
      'Select a configured hosted check; no unique default or verify check is available.',
    );
  }
  const settings = z
    .object({
      check: z.object({ definition: z.string() }).nullable(),
      configuration: z
        .object({
          environmentFingerprint: z.string(),
          repository: z.string().optional(),
          publicLogs: z.literal(true).optional(),
        })
        .nullable(),
      configurationDigest: z.string().nullable(),
      mainAudit: z.unknown().optional(),
    })
    .parse(await session.query('projectHostedCheckDefinitions:current', { checkId: command.checkId }));
  invariant(
    settings.check && settings.configuration && settings.configurationDigest,
    'RUNNER_UNAVAILABLE',
    'Configure this hosted check and its runner first.',
  );
  // From the settings row this selection already read: the receipt names public logs plainly.
  const { checkLogs } = checkLogsField(settings.configuration);
  if (checkLogs) await session.journal.retain(checkLogsKey, () => checkLogs);
  // The same settings row carries the project's landing mode: the next agent's next step (81d12a32).
  const advice = landingAdvice(settings.mainAudit);
  if (advice) await session.journal.retain(landingAdviceKey, () => advice);
  return {
    kind: 'request' as const,
    checkId: command.checkId,
    expectedDefinition: command.expectedDefinition ?? settings.check.definition,
    expectedConfiguration: command.expectedConfiguration ?? settings.configurationDigest,
    expectedEnvironment: command.expectedEnvironment ?? settings.configuration.environmentFingerprint,
  };
}
type HostedQuery = HostedAgentSession['query'];
type HostedDefinition = { version: number; check: { id: string; name: string; definition: string } };
const definitionPage = z.object({
  page: z.array(
    z.object({
      version: z.number(),
      check: z.looseObject({ id: z.string(), name: z.string(), definition: z.string() }),
    }),
  ),
  isDone: z.boolean(),
  continueCursor: z.string(),
});
const currentSettings = z.object({
  githubBindings: z.unknown().optional(),
  runnerGrant: z.unknown().optional(),
  configuration: z
    .looseObject({
      provider: z.string(),
      machineId: z.string().optional(),
      repository: z.string().optional(),
      runsOn: githubActionsRunsOnSchema.optional(),
      concurrencyBudget: z.number().safe().int().min(2).optional(),
      publicLogs: z.literal(true).optional(),
      submodules: z.array(submoduleAllowSchema).optional(),
      credential: z.unknown().optional(),
    })
    .nullable(),
  configurationDigest: z.string().nullable(),
  mainAudit: z.unknown().optional(),
});
/** Definitions are a handful of rows, paged 100 at a time. */
async function hostedDefinitions(query: HostedQuery) {
  const found: HostedDefinition[] = [];
  let cursor: string | null = null;
  do {
    const page = definitionPage.parse(await query('projectHostedCheckDefinitions:list', { cursor }));
    found.push(...page.page);
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor !== null);
  return found;
}
/** The GitHub Actions runner as the server will use it. app-direct: Convex
 * dispatches forge-check.yml on main with an App token whose installation is
 * derived per operation; legacy-credential: the older export/controller path. */
function actionsRunnerSettings(configuration: z.infer<typeof currentSettings>['configuration']) {
  if (configuration?.provider !== 'github-actions') return null;
  const direct = configuration.credential === undefined;
  return {
    mode: direct ? ('app-direct' as const) : ('legacy-credential' as const),
    repository: configuration.repository ?? null,
    workflow: '.github/workflows/forge-check.yml',
    ref: 'main',
    runsOn: configuration.runsOn ?? 'ubuntu-latest',
    concurrencyBudget: configuration.concurrencyBudget ?? 12,
    runner: githubActionsRunnerDescription(configuration.runsOn ?? 'ubuntu-latest'),
    // Said plainly: the owner accepted that check logs are as visible as the runner repository.
    logs:
      configuration.publicLogs === true
        ? publicLogsNotice(configuration.repository)
        : `as visible as ${configuration.repository ?? 'the runner repository'} on GitHub`,
    // Owner-allowed private submodule repositories; anything else is refused.
    submodules: configuration.submodules ?? [],
    // user: a check whose job cannot run project code as its own Candidate user fails setup;
    // shared: the owner allows the runner user there (configure-runner isolation, Issue 3b67363d).
    isolation: configuration.isolation ?? 'user',
    installation: direct ? 'derived per operation via the GitHub App' : 'from the credential reference',
    results: direct ? 'OIDC session plus workflow_run webhook' : 'controller callback',
  };
}
/** Read-only: check definitions, runner and acceptance policy, and what still blocks an agent landing. */
export async function hostedCheckSettings(query: HostedQuery, capabilities: HostedAgentCapabilities) {
  const [definitions, current, read] = await Promise.all([
    hostedDefinitions(query),
    query('projectHostedCheckDefinitions:current', { checkId: '', includeGithubBindings: true }).then(value =>
      currentSettings.parse(value),
    ),
    query('projectAutonomy:read', {}),
  ]);
  const policy = autonomyPolicySchema.parse(read);
  const review = reviewReason(policy, { kind: 'agent', id: capabilities.actor }, null);
  const selected =
    definitions.find(d => d.check.name === 'verify') ??
    (definitions.length === 1 ? definitions[0] : undefined);
  const blockers = [
    ...(selected ? [] : ['No verify (or single) hosted check definition: run configure-check.']),
    ...(current.configuration ? [] : ['No hosted check runner: run configure-runner.']),
    ...(capabilities.checkCallbackConfigured
      ? []
      : ['FORGE_HOSTED_CHECK_KEY_ID is not set on the deployment.']),
    ...(review ? [`Agent landings wait for review: ${review}.`] : []),
  ];
  return {
    definitions: definitions.map(({ version, check }) => ({
      checkId: check.id,
      name: check.name,
      definition: check.definition,
      version,
    })),
    finishCheck: selected ? selected.check.id : null,
    runner: current.configuration
      ? {
          digest: current.configurationDigest,
          configuration: current.configuration,
          ...(isMachineRunner(current.configuration)
            ? { description: machineRunnerDescription(current.configuration) }
            : {}),
        }
      : null,
    actions: actionsRunnerSettings(current.configuration),
    githubBindings: current.githubBindings ?? null,
    ...(current.runnerGrant ? { runnerGrant: current.runnerGrant } : {}),
    ...(current.mainAudit === undefined ? {} : { mainAudit: current.mainAudit }),
    checkCallbackConfigured: capabilities.checkCallbackConfigured,
    policy: { preset: policy.preset, acceptance: policy.acceptance },
    agentLandsOnPass: review === null,
    blockers,
    // Advice only: a configured command that declares no scope never runs scoped.
    proposals: definitions.flatMap(({ check }) => {
      const parsed = proposalCheck.safeParse(check);
      const proposal = parsed.success ? commandScopeProposal(parsed.data) : null;
      return proposal ? [proposal] : [];
    }),
  };
}
const proposalCheck = z.looseObject({
  name: z.string(),
  executable: z.string(),
  args: z.array(z.string()),
  selection: z.looseObject({ scope: z.literal('changed-paths').optional() }).optional(),
});
async function configureCheckRequest(
  session: HostedAgentSession,
  command: z.infer<(typeof hostedAgentCommandSchemas)['configure-check']>,
  operationId: string,
) {
  invariant(
    [command.name, command.checkId, command.command].filter(Boolean).length <= 1 ||
      Boolean(command.checkId && command.command && !command.name),
    'BAD_ARGUMENT',
    'Choose one check: name, checkId, or command (optionally with the checkId it replaces).',
  );
  const definitions = await hostedDefinitions(session.query);
  const name = command.command?.name ?? command.name ?? (command.checkId ? undefined : 'verify');
  const prior = command.checkId
    ? definitions.find(d => d.check.id === command.checkId)
    : definitions.find(d => d.check.name === name);
  const pins = {
    operationId,
    authorityEpoch: session.capabilities.authority.epoch,
    expected: command.expected !== undefined ? command.expected : (prior?.check.definition ?? null),
  };
  if (command.command)
    return {
      name: 'projectHostedCheckDefinitions:configure',
      request: {
        ...pins,
        change: {
          kind: 'definition',
          checkId: command.checkId ?? prior?.check.id ?? randomUUID(),
          command: command.command,
        },
      },
    };
  return {
    name: 'projectHostedCheckImport:fromWork',
    request: { ...pins, select: command.checkId ? { checkId: command.checkId } : { name: name! } },
  };
}
async function configureRunnerRequest(
  session: HostedAgentSession,
  command: z.infer<(typeof hostedAgentCommandSchemas)['configure-runner']>,
  operationId: string,
) {
  invariant(
    Boolean(command.configuration) !== Boolean(command.provider) &&
      !(command.machineId && !['mac', 'self-hosted'].includes(command.provider ?? '')) &&
      !(command.labels && !['mac', 'self-hosted'].includes(command.provider ?? '')) &&
      !(command.repository && command.provider !== 'github-actions') &&
      !(command.runsOn !== undefined && command.provider !== 'github-actions') &&
      !(command.concurrencyBudget !== undefined && command.provider !== 'github-actions') &&
      !(command.publicLogs !== undefined && command.provider !== 'github-actions') &&
      !(command.submodules !== undefined && command.provider !== 'github-actions') &&
      !(command.isolation !== undefined && command.provider !== 'github-actions'),
    'BAD_ARGUMENT',
    'Choose provider:"self-hosted" (optional machineId and labels; mac is a legacy alias), provider:"github-actions" (repository, optional runsOn, concurrencyBudget, publicLogs, submodules and isolation), or a full configuration for another provider.',
  );
  const current = parseHostedResponse(
    currentSettings,
    await session.query('projectHostedCheckDefinitions:current', { checkId: '' }),
  );
  if (command.provider === 'github-actions') {
    // Secretless App runner: the server derives runtime/environment and resolves
    // the installation through the App; no installation ID or credential is sent.
    const currentActions =
      current.configuration?.provider === 'github-actions' ? current.configuration : null;
    const repository = command.repository ?? currentActions?.repository;
    invariant(
      typeof repository === 'string',
      'BAD_ARGUMENT',
      'Pass repository:"OWNER/NAME" for the github-actions runner.',
    );
    // The owner's public-logs acceptance names one repository: it carries over only
    // while the repository stays the same, and publicLogs:false withdraws it.
    const publicLogs =
      command.publicLogs ??
      (currentActions?.publicLogs === true && currentActions.repository === repository ? true : undefined);
    // Allowed submodule repositories carry over the same way; submodules merges changes into them.
    const submodules = mergeSubmoduleAllowlist(
      currentActions?.repository === repository ? currentActions.submodules : undefined,
      command.submodules ?? {},
    );
    // Shared mode (no Candidate user) carries over the same way; isolation:"user" withdraws it.
    const isolation =
      (command.isolation ??
        (currentActions?.isolation === 'shared' && currentActions.repository === repository
          ? 'shared'
          : undefined)) === 'shared';
    return {
      name: 'projectHostedActionsConfigure:configure' as const,
      request: {
        operationId,
        authorityEpoch: session.capabilities.authority.epoch,
        expected: command.expected !== undefined ? command.expected : current.configurationDigest,
        repository,
        runsOn: command.runsOn ?? 'ubuntu-latest',
        ...((command.concurrencyBudget ?? current.configuration?.concurrencyBudget) !== undefined
          ? { concurrencyBudget: command.concurrencyBudget ?? current.configuration?.concurrencyBudget }
          : {}),
        ...(publicLogs ? { publicLogs: true } : {}),
        ...(submodules ? { submodules } : {}),
        ...(isolation ? { isolation: 'shared' } : {}),
      },
    };
  }
  // The worker registers with the same values computed from its own package and
  // process, so they are never typed by hand. Run both in the same environment.
  const labels =
    command.labels ??
    (current.configuration?.provider === 'self-hosted' ? current.configuration.labels : undefined);
  const configuration = command.configuration
    ? command.configuration
    : hostedSelfHostedRunnerSchema.parse({
        provider: 'self-hosted',
        platform: { os: process.platform, arch: process.arch },
        ...(labels !== undefined ? { labels } : {}),
        machineId:
          command.machineId ??
          (current.configuration && isMachineRunner(current.configuration)
            ? current.configuration.machineId
            : randomUUID()),
        runtime: hostedMacRuntime,
        environmentFingerprint: checkEnvironment().fingerprint,
      });
  return {
    name: 'projectHostedCheckDefinitions:configure' as const,
    request: {
      operationId,
      authorityEpoch: session.capabilities.authority.epoch,
      expected: command.expected !== undefined ? command.expected : current.configurationDigest,
      change: { kind: 'runner', configuration },
    },
  };
}
function checkLocalLane(session: HostedAgentSession, laneId?: string) {
  const marker = session.marker();
  if (marker && (!laneId || marker.selection.laneId === laneId)) return marker;
  throw checkoutRequired(
    session,
    laneId,
    'Saving or changing this Lane needs its own folder as ROOT, not the project folder: use the Lane folder printed by start.',
  );
}
const CANCEL_COST =
  "Cancelling discards this submission's queue place, its checks and the retry link. To recover from a failed check, fix the same Lane and land again (it resubmits with retry); a new Lane starts from zero.";
export async function executeHostedAgent(
  session: HostedAgentSession,
  action: HostedAgentAction,
  input: unknown,
): Promise<unknown> {
  if (action === 'recover-apply') {
    const command = hostedAgentCommandSchemas['recover-apply'].parse(input);
    return recoverLocalApply(
      session.root,
      command.applyOperationId,
      new ConvexLaneTransport(session.exchange),
    );
  }

  if (action === 'metrics') return executeHostedMetrics(session, input);
  const operationId = session.journal.operationId,
    epoch = session.capabilities.authority.epoch;
  if (action === 'tests' || action === 'confirm-tests') {
    const command = hostedAgentCommandSchemas[action].parse(input);
    const request = await session.journal.retain('test-contract-request', () => ({
      ...command,
      action,
      operationId,
    }));
    const result = await session.exchange.client.action(
      makeFunctionReference<'action'>('projectIntentTests:execute'),
      { projectId: session.address.projectId, request: canonicalPayload(request) },
    );
    return typeof result === 'string' ? JSON.parse(result) : result;
  }
  if (action === 'configure-check') {
    const command = hostedAgentCommandSchemas['configure-check'].parse(input);
    const selected = await session.journal.retain('configure-check-request', () =>
      configureCheckRequest(session, command, operationId),
    );
    const result = await session.mutation(selected.name, { request: canonicalPayload(selected.request) });
    const proposal = command.command ? commandScopeProposal(command.command) : null;
    return proposal && result && typeof result === 'object' ? { ...result, proposal } : result;
  }
  if (action === 'configure-runner') {
    const command = hostedAgentCommandSchemas['configure-runner'].parse(input);
    const selected = await session.journal.retain('configure-runner-target', () =>
      configureRunnerRequest(session, command, operationId),
    );
    if (selected.name === 'projectHostedActionsConfigure:configure') {
      const result = await session.exchange.client.action(makeFunctionReference<'action'>(selected.name), {
        projectId: session.address.projectId,
        request: canonicalPayload(selected.request),
      });
      return typeof result === 'string' ? JSON.parse(result) : result;
    }
    return session.mutation(selected.name, { request: canonicalPayload(selected.request) });
  }
  if (action === 'start') {
    const command = hostedAgentCommandSchemas.start.parse(input);
    invariant(
      !command.planningItemId || (!command.intentId && !command.outcome),
      'BAD_ARGUMENT',
      'Start from a planning Issue, an Intent, or a new outcome, not a mix.',
    );
    if (command.planningItemId && !session.capabilities.actions.includes('planning'))
      throw unadvertisedActionError('planning');
    const planned = command.planningItemId
      ? await session.journal.retain('start-planned-intent', () =>
          plannedIntent(session, command.planningItemId!),
        )
      : undefined;
    const build = async () => {
      const main = await session.main();
      const parent = command.stackOn ? await selectAgentLane(session, command.stackOn) : null;
      return hostedStartSchema.parse({
        operationId,
        ...(session.capabilities.needsFix !== undefined ? { noticeVersion: 1 } : {}),
        ...(session.capabilities.openLanesVersion === 1 ? { openLanesVersion: 1 } : {}),
        ...(session.agent ? { agent: session.agent } : {}),
        authorityEpoch: epoch,
        expectedMain: { head: main.head, receiptId: main.receipt.id },
        ...((parent?.head ?? command.initialHead)
          ? { initialHead: parent?.head ?? command.initialHead }
          : {}),
        ...(command.stackOn ? { stackOn: command.stackOn } : {}),
        ...(command.stackEntry ? { stackEntry: command.stackEntry } : {}),
        intent: planned
          ? planned
          : command.intentId
            ? { kind: 'existing', intentId: command.intentId }
            : {
                kind: 'new',
                outcome: command.outcome,
                ...(command.constraints === undefined ? {} : { constraints: command.constraints }),
              },
      });
    };
    // The start transaction checks the main pin before anything begins: a moved main rebuilds it.
    const started = await sendMainPinned(session.journal, 'start-request', build, async request => {
      try {
        return await session.mutation('projectHostedStart:start', request);
      } catch (error) {
        if (mainPinRefusal(error, 'start')) throw new MainPinRefused(error);
        throw error;
      }
    });
    return parseHostedResponse(hostedStartResultSchema, started);
  }
  if (action === 'open') {
    const command = hostedAgentCommandSchemas.open.parse(input);
    // Checkout authorizes before transfer and install. Journal hits skip it;
    // adopting a nested copy also needs authorization before moving local files.
    if (
      session.journal.get('open-result') !== undefined ||
      readLaneEntry(command.laneId)?.root.endsWith(`.forge-client${sep}lanes${sep}${command.laneId}`)
    )
      await session.query('projectHostedLanes:select', { laneId: command.laneId });
    return session.journal.retain('open-result', async () => {
      const movedFrom = adoptNestedLaneCopy(session.root, command.laneId, session.address);
      const opened = await checkoutHostedLane(
        session.root,
        { ...command, ...session.address, operationId },
        new ConvexLaneTransport(session.exchange),
      );
      return movedFrom ? { ...opened, movedFrom } : opened;
    });
  }
  if (action === 'save') {
    const command = hostedAgentCommandSchemas.save.parse(input);
    checkLocalLane(session, command.laneId);
    const timing = syncTiming();
    // A save already settled here answers from its receipt and captures nothing new: say so.
    const replayed = saveSettledHere(session.root, operationId);
    const settleBackground = session.capabilities.features?.includes('save-settle-background') ?? false;
    const saved = await saveHostedLane(
      session.root,
      {
        operationId,
        message: command.message,
        ...(command.supersedeFinish ? { supersedeFinish: true } : {}),
      },
      session.exchange,
      { ...saveContract(session.capabilities), settleBackground },
      false,
      { action: 'save', parameters: { ...command, operationId: session.journal.operationId } },
      (id, pending) => waitSaveUntil(session, id, pending),
      timing,
    );
    // Split save (fea47345 C): the upload is in and the save is submitted; the server settles it
    // now and this checkout's next command reads the outcome (reporting a failure), so no wait here.
    if (settleBackground && savePending(saved))
      return {
        status: 'settling',
        operationId,
        laneId: session.marker()?.selection.laneId,
        note: 'Saved: the server is finishing this save now. Your next command here reports its outcome, including any failure.',
        timing: timing.value(),
      };
    const outcome = await awaitSaveOutcome(session, operationId, saved, timing),
      split = timing.value();
    if (!outcome || typeof outcome !== 'object') return outcome;
    // The invocation that saw the outcome keeps its split in the operation journal; a replay answered
    // from the settled receipt did no save work and returns that original split.
    const kept =
      (outcome as { outcome?: unknown }).outcome && Object.keys(split.stepsMs).length
        ? await session.journal.retain('save-timing', () => split)
        : session.journal.get<typeof split>('save-timing');
    // New paths the capture left out by name (credential names), bounded: the save says so.
    const notSaved = capturedNotSaved(session.root, operationId);
    // A save never reports success for edits it did not capture (Issue ca49dc6c): files that differ
    // from the head it saved (edited after its capture, or a replay of an earlier save) are named as
    // unsaved, with the next step. Local digest pass over stat-index misses; no call.
    const unsaved = unsavedAfterSave(session.root, outcome);
    return {
      ...outcome,
      ...(replayed ? { replayed: true } : {}),
      ...(kept ? { timing: kept } : {}),
      ...(notSaved ? { notSaved } : {}),
      ...(unsaved ? { unsavedEdits: unsaved } : {}),
    };
  }
  if (action === 'compose')
    return composeAgentSource(session, hostedAgentCommandSchemas.compose.parse(input), operationId);
  if (action === 'resolve') return resolveHostedAgent(session, input);
  if (action === 'sync') {
    const command = hostedAgentCommandSchemas.sync.parse(input);
    // From a folder that is not the named Lane's checkout, the server Lane would advance while its
    // open checkout here stays on the old head (next command WORK_STALE): refuse first, naming that
    // checkout (friction d467b644). A Lane with no checkout on this machine still syncs server-side.
    if (
      command.apply &&
      !command.candidateId &&
      command.laneId &&
      session.marker()?.selection.laneId !== command.laneId &&
      openLaneRoot(session, command.laneId)
    )
      throw checkoutRequired(
        session,
        command.laneId,
        'Sync updates the Lane checkout as well as the server Lane.',
      );
    const stacking = session.capabilities.features?.includes('sync-stack-on') ?? false;
    if (command.stackOn && !stacking) throw unadvertisedActionError('sync stackOn');
    // Project setting stacking:auto (D2): the last receipt's offer stacks this Lane at its next plain
    // sync. A peer that is no longer landing falls back to the plain sync below, once.
    const autoPeer =
      stacking &&
      !command.stackOn &&
      !command.candidateId &&
      !command.target &&
      command.ontoMain === undefined &&
      !command.cleanOnly &&
      session.journal.get(`sync:${operationId}`) === undefined
        ? autoStackPeer(command.laneId ?? session.marker()?.selection.laneId ?? '')
        : undefined;
    if (autoPeer) command.stackOn = autoPeer;
    const timing = syncTiming();
    // A save this client returned unfinished still pins the marker's old head: settle it (its own
    // progress, no new save) before the sync pins the Lane. No pending save means no call.
    if (
      !command.candidateId &&
      session.journal.get(`sync:${operationId}`) === undefined &&
      session.marker() &&
      (!command.laneId || command.laneId === session.marker()!.selection.laneId)
    )
      await settlePriorHostedSave(session.root, null, session.exchange, (id, pending) =>
        waitSaveUntil(session, id, pending),
      );
    if (command.apply && !markerAt(session.root)) {
      const blocked = retainedLocalApplyBlocked(
        session.root,
        session.journal.get<string>('id:sync-handoff-apply') ?? session.journal.get<string>('id:apply'),
      );
      if (blocked) throw blocked;
    }
    const handoff =
      command.apply && !command.candidateId && session.marker()
        ? await retainSyncHandoff(session, 'sync', command)
        : null;
    timing.mark('settle');
    let prepared;
    const prepare = () =>
      syncAgentSource(session, command, operationId, () =>
        settlePriorHostedSave(session.root, null, session.exchange, (id, pending) =>
          waitSaveUntil(session, id, pending),
        ),
      );
    try {
      try {
        prepared = await prepare();
      } catch (error) {
        // The prepare transaction refused the automatic stack, so no operation began: sync plainly.
        if (
          !autoPeer ||
          !['STACK_PEER_NOT_LANDING', 'NOT_FOUND'].includes(hostedActionError(error, 'sync').code)
        )
          throw error;
        session.journal.forget(`sync:${operationId}`);
        delete command.stackOn;
        prepared = await prepare();
      }
    } catch (error) {
      // Refused before any server operation began: nothing is left to install on a later land.
      if (error instanceof SyncPinsStale && handoff) clearSyncHandoff(session.root, operationId);
      throw error;
    }
    timing.mark('submit');
    let observed: unknown;
    const result = await session.waitSource(operationId, prepared, 'Sync', undefined, value => {
        observed = value;
      }),
      completed = agentSourceOutcome(result);
    timing.mark('hostedWait');
    timing.server(observed);
    if (completed?.status === 'completed') {
      const source = parseHostedResponse(syncResultSchema, completed.result);
      // A retained handoff owns this install even if the marker vanished during the source wait:
      // the apply then refuses with typed recovery instead of the result silently skipping it.
      if (command.apply && (handoff || session.marker()) && source.status !== 'conflict' && source.from) {
        const applied = await applyHostedSync(
          session.root,
          {
            operationId: handoff?.applyOperationId ?? (await session.journal.id('apply')),
            url: session.address.url,
            from: source.from,
            lane: source.lane,
            status: source.status,
          },
          new ConvexLaneTransport(session.exchange),
          // The server just returned this Lane to this caller; its submit reply may carry the State delta.
          { delta: (observed as { delta?: unknown } | undefined)?.delta },
        );
        clearSyncHandoff(session.root, operationId);
        timing.mark('apply');
        return { source: result, applied, timing: timing.value() };
      }
    }
    if (completed && handoff) clearSyncHandoff(session.root, operationId);
    // An automatic restack that would conflict changed nothing: no conflict files, no resolution Lane.
    if (command.cleanOnly) return result;
    const guided = await guideHostedSync(session, result, command.apply);
    if (guided === result) return guided;
    timing.mark('conflict');
    return { ...(guided as object), timing: timing.value() };
  }
  if (action === 'revert') {
    const command = hostedAgentCommandSchemas.revert.parse(input);
    const request = await session.journal.retain('revert-request', () =>
      syncRequestSchema.parse({ kind: 'revert', operationId, authorityEpoch: epoch, ...command }),
    );
    return driveAgentSource(session, 'Sync', operationId, request);
  }
  if (action === 'pin') {
    const command = hostedAgentCommandSchemas.pin.parse(input);
    const laneId = command.laneId ?? session.marker()?.selection.laneId;
    invariant(laneId, 'BAD_ARGUMENT', SELECT_LANE);
    const result = parseHostedResponse(
      pinResultSchema,
      await session.mutation('projectHostedLanePin:setPin', {
        authorityEpoch: epoch,
        laneId,
        pinned: command.pinned,
      }),
    );
    // Advisory machine-local mirror so prune and cache GC keep the checkout even offline.
    const known = readLaneEntry(laneId);
    if (known) recordLane({ laneId, pinned: command.pinned, lastActionAt: known.lastActionAt });
    return { phase: 'pin', ...result };
  }
  if (action === 'abandon-dormant')
    return abandonDormantLanes(session, epoch, hostedAgentCommandSchemas['abandon-dormant'].parse(input));
  if (action === 'complete-merged') {
    hostedAgentCommandSchemas['complete-merged'].parse(input);
    return completeMergedLanes(session, epoch);
  }
  if (action === 'abandon' || action === 'reopen' || action === 'complete') {
    const command = hostedAgentCommandSchemas[action].parse(input);
    if (action === 'complete') {
      const lane = await selectAgentLane(session, command.laneId);
      if (lane.state === 'completed')
        return { phase: 'lifecycle', noop: true, lane: { laneId: lane.laneId, state: lane.state } };
      invariant(lane.state === 'active', 'WORK_STALE', `A ${lane.state} Lane cannot be completed.`);
    }
    const target = 'target' in command ? command.target : undefined;
    const abandonment = action === 'abandon' ? hostedAgentCommandSchemas.abandon.parse(input) : null;
    const applied = async <T>(done: Promise<T>): Promise<T> => {
      const result = await done;
      if (lifecycleApplied(result)) recordLifecycleApplied(session.root, action, input);
      return result;
    };
    if (!target && session.marker()) {
      checkLocalLane(session, command.laneId);
      return applied(
        transitionHostedLane(
          session.root,
          {
            operationId,
            action,
            ...(abandonment
              ? {
                  reason: abandonment.reason,
                  saveFirst: abandonment.saveFirst,
                  keepPatch: abandonment.keepPatch,
                }
              : {}),
          },
          session.exchange,
        ),
      );
    }
    invariant(
      target || !(abandonment?.saveFirst || abandonment?.keepPatch),
      'HOSTED_CHECKOUT_REQUIRED',
      'Saving or keeping local edits first requires an opened Lane checkout.',
    );
    const request = await session.journal.retain('lifecycle-request', async () => {
      const lane = !target ? await selectAgentLane(session, command.laneId) : null;
      return hostedLifecycleRequestSchema.parse({
        operationId,
        authorityEpoch: epoch,
        action,
        target: target ?? {
          kind: 'lane',
          laneId: lane!.laneId,
          expected: saveExpectedSchema.parse({
            head: lane!.head,
            version: lane!.version,
            sourceVersion: lane!.sourceVersion,
            lifecycleVersion: lane!.lifecycleVersion,
          }),
          dirty: false,
          saveOperationId: null,
        },
        ...(abandonment ? { reason: abandonment.reason } : {}),
      });
    });
    return applied(
      session.mutation('projectHostedLifecycle:transition', { request: canonicalPayload(request) }),
    );
  }
  if (action === 'check') {
    const command = hostedAgentCommandSchemas.check.parse(input);
    const request = await session.journal.retain('check-request', async () => {
      const candidate = hostedRecordSchema.options[3].parse(
        await session.query('projectHostedCompose:candidate', { candidateId: command.candidateId }),
      );
      invariant(candidate.result.status === 'clean', 'VIEW_CONFLICT', 'Check a clean hosted Candidate.');
      const check = await checkSelection(session, command);
      invariant(check, 'RUNNER_UNAVAILABLE', 'Select a hosted check.');
      const selection = {
        checkId: check.checkId,
        expectedDefinition: check.expectedDefinition,
        expectedConfiguration: check.expectedConfiguration,
        expectedEnvironment: check.expectedEnvironment,
      };
      return hostedCheckRequestSchema.parse({
        operationId,
        authorityEpoch: epoch,
        candidateId: command.candidateId,
        expectedHead: command.expectedHead ?? candidate.result.head,
        ...selection,
      });
    });
    const run = await session.mutation('projectHostedChecks:enqueue', { request: canonicalPayload(request) });
    const checkLogs = session.journal.get<string>(checkLogsKey);
    return checkLogs && run && typeof run === 'object' ? { ...run, checkLogs } : run;
  }
  if (action === 'prioritize') {
    const command = hostedAgentCommandSchemas.prioritize.parse(input);
    const request = await session.journal.retain('priority-request', async () => {
      const current = await session.query<{ request: { priorityVersion?: number } }>(
        'projectHostedLanding:status',
        { submissionId: command.submissionId },
      );
      return {
        ...command,
        operationId,
        authorityEpoch: epoch,
        expectedVersion: current.request.priorityVersion ?? 0,
      };
    });
    return session.mutation('projectHostedLandingPriority:prioritize', request);
  }
  if (action === 'cancel') {
    const command = hostedAgentCommandSchemas.cancel.parse(input);
    const request = await session.journal.retain('cancel-request', () =>
      hostedLandingCancelSchema.parse({ operationId, authorityEpoch: epoch, ...command }),
    );
    const cancelled = await session.mutation<Record<string, unknown>>('projectHostedLanding:cancel', {
      request: canonicalPayload(request),
    });
    // The landing is ended: this turn has nothing left to wait for (SM-C M1).
    const ended = cancelled?.operationId;
    if (typeof ended === 'string') settleTurnWork([ended]);
    // Item 4 of the agent defaults: the cheap path after a failure is the same Lane, not a new one.
    return typeof cancelled === 'object' && cancelled ? { ...cancelled, cost: CANCEL_COST } : cancelled;
  }
  if (action === 'withdraw') return executeHostedWithdraw(session, input);
  invariant(action === 'finish', 'HOSTED_ACTION_UNSUPPORTED', 'Unsupported hosted action.');
  return executeHostedFinish(session, input);
}

const savePending = (value: unknown) => {
  const reply = value as { status?: unknown; jobId?: unknown } | null;
  return reply?.status === 'submitted' && typeof reply.jobId === 'string';
};
/** One progress subscription for the rest of the caller's budget; no polling or replays. The save
 * is already submitted: an unavailable subscription leaves it pending (its wait resumes it), never
 * turns it into a failure. */
async function waitSaveUntil(
  session: HostedAgentSession,
  operationId: string,
  pending: unknown,
  observe?: (progress: unknown) => void,
) {
  const remaining = (session.waitUntil - Date.now()) / 1000;
  if (!savePending(pending) || remaining <= 0) return pending;
  try {
    return await session.waitSource(operationId, pending, 'Saves', remaining, observe);
  } catch {
    return pending;
  }
}
/** A save waits for its own outcome within the agent budget: the job's progress subscription
 * delivers the receipt and the Lane binding advances from it, with no replay or extra call. A save
 * still running at the deadline returns `submitted` (the CLI reports IN_PROGRESS and its wait). */
async function awaitSaveOutcome(
  session: HostedAgentSession,
  operationId: string,
  saved: unknown,
  timing?: StepTimer,
) {
  if (!savePending(saved)) return saved;
  let last: unknown;
  const observed = (await waitSaveUntil(session, operationId, saved, value => {
    last = value;
  })) as {
    outcome?: { status: string; result?: unknown };
  } | null;
  timing?.mark('hostedWait');
  timing?.server(last);
  if (observed?.outcome) {
    applyObservedSaveOutcome(session.root, operationId, observed as { outcome: { status: string } });
    timing?.mark('apply');
    return observed;
  }
  return observed ?? saved;
}
