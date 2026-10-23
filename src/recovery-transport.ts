// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { ConvexExchange } from './exchange-client.js';
import { downloadExchangeFile } from './exchange-download-file.js';
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
  return Object.assign(exchange, {
    prepare: async () =>
      JSON.parse(
        await exchange.client.query(makeFunctionReference<'query'>('projectRecovery:prepare'), scope),
      ),
    reconnect: async (selection: RecoverySelection, requestHash: string, role: 'owner' | 'client') =>
      JSON.parse(
        await exchange.client.mutation(makeFunctionReference<'mutation'>('projectRecovery:reconnect'), {
          ...scope,
          selection: JSON.stringify(selection),
          requestHash,
          role,
        }),
      ),
    archive: async (selection: RecoverySelection, path: string) => {
      await downloadExchangeFile(
        { sha256: selection.checkpointSha256, size: selection.checkpointSize },
        path,
        async offset => {
          const part = await exchange.client.action(
            makeFunctionReference<'action'>('projectBackupActions:downloadPart'),
            {
              id: selection.backupId,
              offset,
              digest: selection.checkpointSha256,
            },
          );
          invariant(
            part.digest === selection.checkpointSha256 && part.size === selection.checkpointSize,
            'INVALID_WORK_BACKUP',
            'Downloaded archive differs from the selected checkpoint.',
          );
          return Buffer.from(part.data);
        },
      );
    },
  });
}
