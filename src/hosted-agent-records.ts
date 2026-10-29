// SPDX-License-Identifier: Apache-2.0
import { hostedRecordCommands } from './hosted-record-input.js';
import { HostedAgentJournal } from './hosted-agent-journal.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { ForgeError, invariant } from './errors.js';
import type { HostedAgentTransport, HostedAgentResponse } from './hosted-agent-transport.js';
import { z } from 'zod';
/** These finite record endpoints authorize on the server themselves. No capability
 * round trip, source worker, owner service or edit hook network dependency. */
export async function executeHostedRecords(
  transport: HostedAgentTransport,
  action: keyof typeof hostedRecordCommands,
  input: Record<string, unknown>,
): Promise<HostedAgentResponse> {
  const { operationId, ...parameters } = input;
  const parsed = hostedRecordCommands[action].safeParse(parameters);
  invariant(
    parsed.success && (operationId === undefined || z.uuid().safeParse(operationId).success),
    'BAD_ARGUMENT',
    'Send valid hosted record inputs and an optional operation UUID.',
  );
  try {
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
    const command = { ...parsed.data, operationId: journal.operationId };
    const request =
      action === 'peer-ack' ? { operationId: journal.operationId, answers: [command] } : command;
    const endpoint =
      action === 'friction'
        ? 'projectHostedFriction:capture'
        : action === 'decide'
          ? 'projectHostedDecisions:decide'
          : 'projectHostedOverlapAcks:append';
    const result = await transport.mutation(endpoint, { request: canonicalPayload(request) });
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
