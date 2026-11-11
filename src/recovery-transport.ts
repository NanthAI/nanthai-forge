// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { ConvexExchange } from './exchange-client.js';
import { downloadArchiveFile } from './archive-download-file.js';
import { hostedRecoveryPageSchema, type RecoveryTable } from './recovery-hosted-protocol.js';
import { hydrateLandingHistory } from './landing-capsule-client.js';
import { invariant } from './errors.js';
import type { RecoveryRequest, RecoverySelection } from './recovery-protocol.js';
import type { RecoveryTransport } from './recovery-source.js';

export function recoveryTransport(request: RecoveryRequest): RecoveryTransport {
  const exchange = new ConvexExchange(
    request.url,
    process.env.FORGE_AUTH_TOKEN,
    request.projectId,
    request.operationId,
    null,
  );
  const scope = { projectId: request.projectId, operationId: request.operationId };
  let capsuleProtocol = true;
  const query = async (name: string, args: Record<string, unknown>) => {
    const reference = makeFunctionReference<'query'>(name);
    try {
      return await exchange.client.query(reference, {
        ...args,
        ...(capsuleProtocol ? { capsuleProtocol: 1 } : {}),
      });
    } catch (error) {
      if (
        !capsuleProtocol ||
        !(error instanceof Error) ||
        !error.message.includes('ArgumentValidationError') ||
        !error.message.includes('capsuleProtocol')
      )
        throw error;
      capsuleProtocol = false;
      return exchange.client.query(reference, args);
    }
  };
  return Object.assign(exchange, {
    prepare: async () => JSON.parse(await query('projectRecovery:prepare', scope)),
    hostedPage: async (selection: RecoverySelection, table: RecoveryTable, cursor: string | null) => {
      const args = { projectId: request.projectId, selection: JSON.stringify(selection), table, cursor };
      const value = await query('projectRecoveryHosted:page', args);
      const hydrated = await hydrateLandingHistory('projectRecoveryHosted:page', args, value, (name, input) =>
        exchange.client.action(makeFunctionReference<'action'>(name), {
          ...input,
          projectId: request.projectId,
        }),
      );
      return hostedRecoveryPageSchema.parse(JSON.parse(hydrated as string));
    },
    archive: async (selection: RecoverySelection, path: string) => {
      const signed = await exchange.client.mutation(
        makeFunctionReference<'mutation'>('backupTransfer:sign'),
        { id: selection.backupId, digest: selection.checkpointSha256 },
      );
      await downloadArchiveFile(
        { sha256: selection.checkpointSha256, size: selection.checkpointSize },
        path,
        async offset => {
          const part =
            signed ??
            (await exchange.client.action(
              makeFunctionReference<'action'>('projectBackupActions:downloadPart'),
              {
                id: selection.backupId,
                offset,
                digest: selection.checkpointSha256,
              },
            ));
          invariant(
            part.digest === selection.checkpointSha256 && part.size === selection.checkpointSize,
            'INVALID_WORK_BACKUP',
            'Downloaded archive differs from the selected checkpoint.',
          );
          return part;
        },
      );
    },
  });
}
