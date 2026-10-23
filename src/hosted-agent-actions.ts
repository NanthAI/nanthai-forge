// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { hostedAgentCommandSchemas, type HostedAgentAction } from './hosted-agent-contract.js';
import { hostedStartSchema, hostedStartResultSchema } from './hosted-lane.js';
import { checkoutHostedLane } from './hosted-lane-checkout.js';
import { ConvexLaneTransport } from './hosted-lane-transport.js';
import { saveHostedLane } from './hosted-save-client.js';
import { transitionHostedLane } from './hosted-lifecycle-client.js';
import { hostedLifecycleRequestSchema } from './hosted-lifecycle.js';
import { hostedCheckRequestSchema } from './hosted-check.js';
import { hostedLandingRequestSchema } from './hosted-landing.js';
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
  const operationId = session.journal.operationId,
    epoch = session.capabilities.authority.epoch;
  if (action === 'start') {
    const command = hostedAgentCommandSchemas.start.parse(input);
    const request = await session.journal.retain('start-request', async () => {
      const main = await session.main();
      return hostedStartSchema.parse({
        operationId,
        authorityEpoch: epoch,
        expectedMain: { head: main.head, receiptId: main.receipt.id },
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
  invariant(action === 'finish', 'HOSTED_ACTION_UNSUPPORTED', 'Unsupported hosted action.');
  const command = hostedAgentCommandSchemas.finish.parse(input);
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
    if (completed?.status !== 'completed') return { phase: 'compose', composeOperationId, progress };
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
    return hostedLandingRequestSchema.parse({
      operationId,
      authorityEpoch: epoch,
      channel: 'main',
      expectedMain: candidate.base,
      candidateId,
      expectedHead: candidate.result.status === 'clean' ? candidate.result.head : null,
      agent: true,
      check: await checkSelection(session, command.check),
      finish: { composeOperationId, after: command.after },
    });
  });
  // Account JWTs still make agent requests. Person authority is never selected by CLI input.
  const result = await session.mutation('projectHostedLanding:enqueue', {
    request: canonicalPayload(request),
  });
  return { phase: 'finish', composeOperationId, submission: result };
}
