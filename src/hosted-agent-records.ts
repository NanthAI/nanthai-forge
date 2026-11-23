// SPDX-License-Identifier: Apache-2.0
import { planningIssueArguments } from './planning-issue-arguments.js';
import { describeIssues } from './argument-errors.js';
import { actionRoot } from './agent-verbs.js';
import { hostedRecordCommands } from './hosted-record-input.js';
import { HostedAgentJournal } from './hosted-agent-journal.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { ForgeError, invariant } from './errors.js';
import type { HostedAgentTransport, HostedAgentResponse } from './hosted-agent-transport.js';
import { z } from 'zod';
import { frictionTriageProblem } from './friction-types.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
/** These finite record endpoints authorize on the server themselves. No capability
 * round trip, source worker, owner service or edit hook network dependency. */
export async function executeHostedRecords(
  transport: HostedAgentTransport,
  action: keyof typeof hostedRecordCommands,
  input: Record<string, unknown>,
  /** Resolves a short Issue id (the transport passes its planning resolver, so this module loads nothing). */
  resolveItemId?: (prefix: string) => Promise<string>,
): Promise<HostedAgentResponse> {
  const { operationId, ...parameters } = planningIssueArguments(action, input);
  // A short Issue id resolves to its full id before validation, so the record stores the full id.
  if (
    action === 'friction-triage' &&
    typeof parameters.planningItemId === 'string' &&
    resolveItemId &&
    // A short hex prefix (a full id is 36 characters); checked inline so this module loads nothing new.
    /^[0-9a-f]{8}[0-9a-f-]{0,27}$/i.test(parameters.planningItemId)
  )
    parameters.planningItemId = await resolveItemId(parameters.planningItemId);
  if (
    (action === 'friction' || (action === 'friction-triage' && parameters.status === 'fixed')) &&
    parameters.laneId === undefined
  ) {
    const marker = readHostedLaneCheckout(transport.root);
    if (marker) parameters.laneId = marker.selection.laneId;
  }
  // A decision may name only this session's own agent (review R-08): when the client knows its
  // session slug, any other slug is refused before a call, so one session cannot sign as another.
  const session = action === 'decide' ? transport.agentSlug() : null;
  invariant(
    !session || parameters.actor === undefined || parameters.actor === session,
    'BAD_ARGUMENT',
    `A decision names this session's agent ${session}, not ${String(parameters.actor)}. Omit actor or send "${session}".`,
  );
  const parsed = hostedRecordCommands[action].safeParse(parameters);
  invariant(
    parsed.success && (operationId === undefined || z.uuid().safeParse(operationId).success),
    'BAD_ARGUMENT',
    `Invalid ${action} parameters: ${
      !parsed.success ? describeIssues(parsed.error.issues, parameters) : 'operationId: expected a UUID'
    }. Run ${actionRoot(action)} ${action} --help, correct the named fields and retry.`,
  );
  if (action === 'friction-triage') {
    const problem = frictionTriageProblem(parsed.data as Parameters<typeof frictionTriageProblem>[0]);
    invariant(!problem, 'BAD_ARGUMENT', `Invalid friction-triage parameters: ${problem}`);
  }
  try {
    if (action === 'friction-list') {
      const result = await transport.query('projectHostedFriction:read', {
        request: canonicalPayload(parsed.data),
      });
      return { schema: 1, transport: 'hosted', action, operationId: null, resolved: null, result };
    }
    if (action === 'decisions') {
      const command = hostedRecordCommands.decisions.parse(parameters);
      const result = await transport.query('projectHostedDecisions:list', {
        cursor: command.cursor,
        ...(command.target ? { target: canonicalPayload(command.target) } : {}),
      });
      return { schema: 1, transport: 'hosted', action, operationId: null, resolved: null, result };
    }
    const journal = new HostedAgentJournal(
      transport.root,
      transport.address,
      'authenticated-record-caller',
      action,
      parsed.data,
      operationId as string | undefined,
    );
    const cli = action === 'friction' ? transport.cli : undefined;
    const command = { ...parsed.data, operationId: journal.operationId, ...(cli ? { cli } : {}) };
    const endpoint =
      action === 'friction'
        ? 'projectHostedFriction:capture'
        : action === 'friction-triage'
          ? 'projectHostedFriction:triage'
          : action === 'report-abuse'
            ? 'abuseReports:report'
            : 'projectHostedDecisions:decide';
    const result = await transport.mutation(endpoint, { request: canonicalPayload(command) });
    return {
      schema: 1,
      transport: 'hosted',
      action,
      operationId: journal.operationId,
      resolved: { operationId: journal.operationId },
      result,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      /(?:Could not find (?:public )?function|No (?:public )?function found|Function .* not found)/i.test(
        error.message,
      )
    )
      throw new ForgeError(
        'HOSTED_ACTION_UNSUPPORTED',
        'This server does not implement hosted records. Deploy the record API before retrying; no native Work fallback was attempted.',
      );
    throw error;
  }
}
