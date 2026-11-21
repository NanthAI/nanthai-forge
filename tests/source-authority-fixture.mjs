// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { hostedMainV2Schema } from '../dist/hosted-main.js';

export function seedAuthorityMain(fixture, projectId, head, authority) {
  const operationId = randomUUID();
  return fixture.insert('projectHostedChannels', {
    projectId,
    name: 'main',
    operationId,
    selection: JSON.stringify(
      hostedMainV2Schema.parse({
        schema: 2,
        projectId,
        snapshotId: operationId,
        sourceRevision: 0,
        authority,
        channel: 'main',
        head,
        receipt: { id: `bootstrap:${head}`, kind: 'native', previousHead: null, previousReceiptId: null },
      }),
    ),
  });
}
