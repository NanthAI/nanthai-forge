// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { makeFunctionReference } from 'convex/server';
import { coordinationClient } from './coordination-client.js';
import { deploymentUrl } from './auth-store.js';
import { invariant } from './errors.js';

export const MAKE_EDITABLE_HELP = `nforge make-editable DEPLOYMENT_URL PROJECT_ID [OPERATION_UUID]
Owner only. Turns a completed GitHub import that is still owned by a native owner
into a hosted project agents can start Lanes on. Uses the bytes already stored;
nothing is uploaded and no local owner is created. Retry with the printed
OPERATION_UUID after an interrupted reply.
`;
export async function makeEditableCli(args: string[]) {
  if (!args.length || args.includes('--help')) {
    process.stdout.write(MAKE_EDITABLE_HELP);
    return undefined;
  }
  const [deployment, projectId, operationId = randomUUID(), extra] = args;
  invariant(deployment && projectId && !extra, 'BAD_ARGUMENT', MAKE_EDITABLE_HELP);
  process.stderr.write(`operationId ${operationId}\n`);
  const client = coordinationClient(deploymentUrl(deployment), process.env.FORGE_AUTH_TOKEN);
  return JSON.parse(
    (await client.mutation(makeFunctionReference<'mutation'>('projectHostedBirth:makeEditable'), {
      projectId,
      operationId,
    })) as string,
  );
}
