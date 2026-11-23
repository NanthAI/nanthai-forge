// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { hostedRecordsReadSchema } from './hosted-record-read.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { memberDataNotice } from './member-data-notice.js';
import { ForgeError, invariant } from './errors.js';
import { hostedActionError, hostedFailureDetail } from './hosted-action-error.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';

/** A cursor keeps its original collection/filter/project; no full Work or source hydration. */
export async function readHostedAgentRecords(transport: HostedAgentTransport, input: unknown) {
  const parsed = hostedRecordsReadSchema.safeParse(input);
  invariant(parsed.success, 'BAD_ARGUMENT', 'Invalid records parameters. Use records --help.');
  const command = parsed.data;
  const selection = canonicalPayload({
    projectId: transport.address.projectId,
    collection: command.collection,
    parentId: command.parentId ?? null,
    status: command.status ?? null,
  });
  let cursor = command.cursor;
  if (cursor !== null) {
    let retained: { selection: string; cursor: string };
    try {
      retained = JSON.parse(cursor);
    } catch {
      throw new ForgeError('BAD_ARGUMENT', 'Use the original returned records cursor.');
    }
    invariant(
      retained && retained.selection === selection && typeof retained.cursor === 'string',
      'BAD_ARGUMENT',
      'Continue the original records collection and filters.',
    );
    cursor = retained.cursor;
  }
  const result = await transport
    .query<Record<string, unknown>>('projectHostedRecordReads:read', {
      request: canonicalPayload({ ...command, cursor }),
    })
    .catch(error => {
      const failure = hostedActionError(error, 'agent records');
      const detail = hostedFailureDetail(failure.message);
      if (failure.code === 'HOSTED_ACTION_FAILED' && detail)
        throw new ForgeError(failure.code, `Hosted agent records failed${detail}.`);
      throw failure;
    });
  return {
    ...result,
    ...(typeof result.nextCursor === 'string'
      ? { nextCursor: canonicalPayload({ selection, cursor: result.nextCursor }) }
      : {}),
    notice: memberDataNotice,
  };
}
