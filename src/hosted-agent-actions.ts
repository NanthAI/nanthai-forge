import { executeHostedMetrics } from './hosted-agent-metrics.js';
import { isMachineRunner, machineRunnerDescription } from './hosted-machine-runner.js';
import { hostedLandingDesiredSchema } from './hosted-landing-desired.js';
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { githubActionsRunsOnSchema, githubActionsRunnerDescription } from './github-actions-runner-label.js';
import { makeFunctionReference } from 'convex/server';
import { hostedAgentCommandSchemas, type HostedAgentAction } from './hosted-agent-contract.js';
import { hostedStartSchema, hostedStartResultSchema } from './hosted-lane.js';
import { checkoutHostedLane } from './hosted-lane-checkout.js';
import { ConvexLaneTransport } from './hosted-lane-transport.js';
import { saveHostedLane } from './hosted-save-client.js';
import { transitionHostedLane } from './hosted-lifecycle-client.js';
import { hostedLifecycleRequestSchema } from './hosted-lifecycle.js';
import { randomUUID } from 'node:crypto';
import { hostedCheckRequestSchema, hostedSelfHostedRunnerSchema } from './hosted-check.js';
import { hostedMacRuntime } from './hosted-mac-lease.js';
import { checkEnvironment } from './check-environment.js';
import { autonomyPolicySchema, reviewReason } from './autonomy-policy.js';
import type { HostedAgentCapabilities } from './hosted-agent-contract.js';
import { hostedLandingRequestSchema, hostedLandingCancelSchema } from './hosted-landing.js';
import { hostedRecordSchema } from './hosted-records.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { syncRequestSchema, syncResultSchema } from './hosted-sync.js';
import { applyHostedSync } from './hosted-sync-client.js';
import {
  composeAgentSource,
  driveAgentSource,
  syncAgentSource,
  selectAgentLane,
} from './hosted-agent-source.js';
import { invariant } from './errors.js';
import { saveExpectedSchema } from './hosted-save.js';
import type { HostedAgentSession } from './hosted-agent-transport.js';
const outcome = z.object({ outcome: z.object({ status: z.string(), result: z.unknown().optional() }) });
export function agentSourceOutcome(value: unknown) {
  const parsed = outcome.safeParse(value);
  return parsed.success ? parsed.data.outcome : null;
}
async function checkSelection(
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
      configuration: z.object({ environmentFingerprint: z.string() }).nullable(),
      configurationDigest: z.string().nullable(),
      mainAudit: z.unknown().optional(),
    })
    .parse(await session.query('projectHostedCheckDefinitions:current', { checkId: command.checkId }));
  invariant(
    settings.check && settings.configuration && settings.configurationDigest,
    'RUNNER_UNAVAILABLE',
    'Configure this hosted check and its runner first.',
  );
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
  configuration: z
    .looseObject({
      provider: z.string(),
      machineId: z.string().optional(),
      repository: z.string().optional(),
      runsOn: githubActionsRunsOnSchema.optional(),
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
    runner: githubActionsRunnerDescription(configuration.runsOn ?? 'ubuntu-latest'),
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
    ...(current.mainAudit === undefined ? {} : { mainAudit: current.mainAudit }),
    checkCallbackConfigured: capabilities.checkCallbackConfigured,
    policy: { preset: policy.preset, acceptance: policy.acceptance },
    agentLandsOnPass: review === null,
    blockers,
  };
}
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
      !(command.runsOn !== undefined && command.provider !== 'github-actions'),
    'BAD_ARGUMENT',
    'Choose provider:"self-hosted" (optional machineId and labels; mac is a legacy alias), provider:"github-actions" (repository, optional runsOn), or a full configuration for another provider.',
  );
  const current = currentSettings.parse(
    await session.query('projectHostedCheckDefinitions:current', { checkId: '' }),
  );
  if (command.provider === 'github-actions') {
    // Secretless App runner: the server derives runtime/environment and resolves
    // the installation through the App; no installation ID or credential is sent.
    const repository =
      command.repository ??
      (current.configuration?.provider === 'github-actions' ? current.configuration.repository : undefined);
    invariant(
      typeof repository === 'string',
      'BAD_ARGUMENT',
      'Pass repository:"OWNER/NAME" for the github-actions runner.',
    );
    return {
      name: 'projectHostedActionsConfigure:configure' as const,
      request: {
        operationId,
        authorityEpoch: session.capabilities.authority.epoch,
        expected: command.expected !== undefined ? command.expected : current.configurationDigest,
        repository,
        runsOn: command.runsOn ?? 'ubuntu-latest',
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
  invariant(
    marker && (!laneId || marker.selection.laneId === laneId),
    'HOSTED_CHECKOUT_REQUIRED',
    'Open this Lane into ROOT before saving local files or changing its local lifecycle.',
  );
  return marker;
}
export async function executeHostedAgent(
  session: HostedAgentSession,
  action: HostedAgentAction,
  input: unknown,
): Promise<unknown> {
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
    return session.mutation(selected.name, { request: canonicalPayload(selected.request) });
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
    const request = await session.journal.retain('start-request', async () => {
      const main = await session.main();
      const parent = command.stackOn ? await selectAgentLane(session, command.stackOn) : null;
      return hostedStartSchema.parse({
        operationId,
        ...(session.capabilities.needsFix !== undefined ? { noticeVersion: 1 } : {}),
        authorityEpoch: epoch,
        expectedMain: { head: main.head, receiptId: main.receipt.id },
        ...((parent?.head ?? command.initialHead)
          ? { initialHead: parent?.head ?? command.initialHead }
          : {}),
        ...(command.stackOn ? { stackOn: command.stackOn } : {}),
        ...(command.stackEntry ? { stackEntry: command.stackEntry } : {}),
        intent: command.intentId
          ? { kind: 'existing', intentId: command.intentId }
          : {
              kind: 'new',
              outcome: command.outcome,
              ...(command.constraints === undefined ? {} : { constraints: command.constraints }),
            },
      });
    });
    return hostedStartResultSchema.parse(await session.mutation('projectHostedStart:start', request));
  }
  if (action === 'open') {
    const command = hostedAgentCommandSchemas.open.parse(input);
    await session.query('projectHostedLanes:select', { laneId: command.laneId });
    return session.journal.retain('open-result', () =>
      checkoutHostedLane(
        session.root,
        { ...command, ...session.address, operationId },
        new ConvexLaneTransport(session.exchange),
      ),
    );
  }
  if (action === 'save') {
    const command = hostedAgentCommandSchemas.save.parse(input);
    checkLocalLane(session, command.laneId);
    return saveHostedLane(session.root, { operationId, message: command.message }, session.exchange);
  }
  if (action === 'compose')
    return composeAgentSource(session, hostedAgentCommandSchemas.compose.parse(input), operationId);
  if (action === 'sync') {
    const command = hostedAgentCommandSchemas.sync.parse(input);
    const result = await syncAgentSource(session, command, operationId),
      completed = agentSourceOutcome(result);
    if (completed?.status === 'completed') {
      const source = syncResultSchema.parse(completed.result);
      if (command.apply && session.marker() && source.status !== 'conflict' && source.from) {
        const applied = await applyHostedSync(
          session.root,
          {
            operationId: await session.journal.id('apply'),
            url: session.address.url,
            from: source.from,
            lane: source.lane,
            status: source.status,
          },
          new ConvexLaneTransport(session.exchange),
        );
        return { source: result, applied };
      }
    }
    return result;
  }
  if (action === 'revert') {
    const command = hostedAgentCommandSchemas.revert.parse(input);
    const request = await session.journal.retain('revert-request', () =>
      syncRequestSchema.parse({ kind: 'revert', operationId, authorityEpoch: epoch, ...command }),
    );
    return driveAgentSource(session, 'Sync', operationId, request);
  }
  if (action === 'abandon' || action === 'reopen') {
    const command = hostedAgentCommandSchemas[action].parse(input);
    if (!command.target && session.marker()) {
      checkLocalLane(session, command.laneId);
      return transitionHostedLane(
        session.root,
        {
          operationId,
          action,
          ...('reason' in command ? { reason: command.reason, saveFirst: command.saveFirst } : {}),
        },
        session.exchange,
      );
    }
    invariant(
      command.target || !('saveFirst' in command) || !command.saveFirst,
      'HOSTED_CHECKOUT_REQUIRED',
      'Saving local edits first requires an opened Lane checkout.',
    );
    const request = await session.journal.retain('lifecycle-request', async () => {
      const lane = !command.target ? await selectAgentLane(session, command.laneId) : null;
      return hostedLifecycleRequestSchema.parse({
        operationId,
        authorityEpoch: epoch,
        action,
        target: command.target ?? {
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
        ...('reason' in command ? { reason: command.reason } : {}),
      });
    });
    return session.mutation('projectHostedLifecycle:transition', { request: canonicalPayload(request) });
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
    return session.mutation('projectHostedChecks:enqueue', { request: canonicalPayload(request) });
  }
  if (action === 'cancel') {
    const command = hostedAgentCommandSchemas.cancel.parse(input);
    const request = await session.journal.retain('cancel-request', () =>
      hostedLandingCancelSchema.parse({ operationId, authorityEpoch: epoch, ...command }),
    );
    return session.mutation('projectHostedLanding:cancel', { request: canonicalPayload(request) });
  }
  invariant(action === 'finish', 'HOSTED_ACTION_UNSUPPORTED', 'Unsupported hosted action.');
  const command = hostedAgentCommandSchemas.finish.parse(input);
  if (!command.after && !command.candidateId && !command.inputs)
    command.after = await session.journal.retain('stack-parent-entry', async () => {
      const selected = await selectAgentLane(session, command.laneId);
      return selected.stack && !selected.stack.detached ? (selected.stack.entryId ?? null) : null;
    });
  const marker = session.marker();
  if (
    !command.candidateId &&
    !command.inputs &&
    marker &&
    (!command.laneId || marker.selection.laneId === command.laneId)
  ) {
    const saveOperationId = await session.journal.id('save');
    const saved = await saveHostedLane(
      session.root,
      { operationId: saveOperationId, message: command.message },
      session.exchange,
    );
    if (agentSourceOutcome(saved)?.status !== 'completed')
      return { phase: 'save', saveOperationId, progress: saved };
  }
  const composeOperationId = command.composeOperationId ?? (await session.journal.id('compose'));
  const desired = session.journal.get<z.infer<typeof hostedLandingDesiredSchema>>('desired-landing');
  if (desired)
    return {
      phase: 'finish',
      composeOperationId,
      submission: await session.mutation('projectHostedLandingDesired:submit', {
        request: canonicalPayload({ ...desired, governanceVersion: 1 }),
      }),
    };
  let candidateId = command.candidateId;
  if (!candidateId) {
    const progress = await composeAgentSource(
      session,
      hostedAgentCommandSchemas.compose.parse({
        ...(command.laneId ? { laneId: command.laneId } : {}),
        ...(command.intentId ? { intentId: command.intentId } : {}),
        ...(command.inputs ? { inputs: command.inputs } : {}),
        dependencies: command.dependencies,
        message: command.message,
      }),
      composeOperationId,
    );
    const completed = agentSourceOutcome(progress);
    if (completed?.status !== 'completed') {
      if (command.accept === false) return { phase: 'compose', composeOperationId, progress };
      const desired = await session.journal.retain('desired-landing', async () =>
        hostedLandingDesiredSchema.parse({
          governanceVersion: 1,
          operationId,
          authorityEpoch: epoch,
          composeOperationId,
          after: command.after,
          check: await checkSelection(session, command.check),
          ...(command.keepOpen === undefined ? {} : { keepOpen: command.keepOpen }),
        }),
      );
      return {
        phase: 'finish',
        composeOperationId,
        submission: await session.mutation('projectHostedLandingDesired:submit', {
          request: canonicalPayload({ ...desired, governanceVersion: 1 }),
        }),
      };
    }
    candidateId = hostedRecordSchema.options[3].parse(completed.result).id;
  } else
    invariant(
      command.composeOperationId,
      'BAD_ARGUMENT',
      'Existing Candidate finish requires its original composeOperationId.',
    );
  const request = await session.journal.retain('finish-request', async () => {
    const candidate = hostedRecordSchema.options[3].parse(
      await session.query('projectHostedCompose:candidate', { candidateId }),
    );
    if (command.accept === false) {
      invariant(candidate.result.status === 'clean', 'VIEW_CONFLICT', 'Check a clean hosted Candidate.');
      const check = await checkSelection(session, command.check);
      const { kind: _kind, ...selection } = check;
      void _kind;
      return hostedCheckRequestSchema.parse({
        operationId,
        authorityEpoch: epoch,
        candidateId,
        expectedHead: candidate.result.head,
        ...selection,
      });
    }
    return hostedLandingRequestSchema.parse({
      governanceVersion: 1,
      operationId,
      authorityEpoch: epoch,
      channel: 'main',
      expectedMain: candidate.base,
      candidateId,
      expectedHead: candidate.result.status === 'clean' ? candidate.result.head : null,
      agent: true,
      check: await checkSelection(session, command.check),
      finish: { composeOperationId, after: command.after },
      ...(command.keepOpen === undefined ? {} : { keepOpen: command.keepOpen }),
    });
  });
  if (command.accept === false)
    return {
      phase: 'check',
      composeOperationId,
      run: await session.mutation('projectHostedChecks:enqueue', { request: canonicalPayload(request) }),
    };
  // Account JWTs still make agent requests. Person authority is never selected by CLI input.
  const result = await session.mutation('projectHostedLanding:enqueue', {
    request: canonicalPayload({ ...request, governanceVersion: 1 }),
  });
  let queueAheadSelection: unknown;
  try {
    const read = await session.query<{ queueAheadSelection?: unknown }>('projectHostedLanding:status', {
      submissionId: (result as { id: string }).id,
    });
    queueAheadSelection = read.queueAheadSelection;
  } catch {
    /* Advisory reads never affect admission. */
  }
  return {
    phase: 'finish',
    composeOperationId,
    submission: result,
    ...(queueAheadSelection ? { queueAheadSelection } : {}),
  };
}
