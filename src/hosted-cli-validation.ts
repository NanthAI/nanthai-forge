// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { hostedAgentAction, hostedAgentCommandSchemas } from './hosted-agent-contract.js';
import { hostedDiffSchema, hostedPeersSchema } from './hosted-agent-reads.js';
import { hostedWaitSchema } from './hosted-agent-observe.js';
import { hostedSourceShowSchema } from './mcp-hosted-source.js';
import { liveLanesInput } from './hosted-live-lanes.js';
import { unknownActionError } from './hosted-agent-version.js';
import { ForgeError, invariant } from './errors.js';
import { frictionInputSchema } from './friction-types.js';

export function validateNativeFrictionCommand(input: Record<string, unknown>) {
  const { operationId, ...parameters } = input;
  const parsed = frictionInputSchema.omit({ operationId: true }).safeParse(parameters);
  invariant(
    parsed.success && (operationId === undefined || z.uuid().safeParse(operationId).success),
    'BAD_ARGUMENT',
    `Invalid friction parameters: ${!parsed.success ? parsed.error.issues.map(issue => `${issue.path.join('.') || 'parameters'}: ${issue.message}`).join('; ') : 'operationId: expected a UUID'}. Run nforge agent ROOT friction --help and retry.`,
  );
}

/** The same enforced schemas, before installed-CLI release discovery. Only
 * argument validation happens here; dispatch retains authority and retry checks. */
export function validateHostedCliCommand(
  root: string,
  requestedAction: string,
  selected: Record<string, unknown>,
) {
  const input = Object.fromEntries(
    Object.entries(selected).filter(([key]) => !['url', 'projectId', 'action'].includes(key)),
  );
  const local = {
    lanes: liveLanesInput,
    diff: hostedDiffSchema,
    peers: hostedPeersSchema,
    wait: hostedWaitSchema,
    show: hostedSourceShowSchema.omit({ action: true }),
  };
  let schema: z.ZodType;
  let parameters = input;
  if (Object.hasOwn(local, requestedAction)) {
    schema = local[requestedAction as keyof typeof local];
  } else {
    let action: keyof typeof hostedAgentCommandSchemas;
    try {
      action = hostedAgentAction(requestedAction);
    } catch (error) {
      if (error instanceof ForgeError && error.code === 'HOSTED_ACTION_UNSUPPORTED')
        throw unknownActionError(root, requestedAction);
      throw error;
    }
    if (!['status', 'observe'].includes(action)) {
      const { operationId, ...rest } = input;
      invariant(
        operationId === undefined || z.uuid().safeParse(operationId).success,
        'BAD_ARGUMENT',
        `operationId: expected a UUID. Run nforge agent ROOT ${requestedAction} --help and retry.`,
      );
      parameters = rest;
    }
    if (action === 'start') {
      const { path, open, ...rest } = parameters;
      invariant(
        (path === undefined || (typeof path === 'string' && path !== '')) &&
          (open === undefined || typeof open === 'boolean'),
        'BAD_ARGUMENT',
        'start path is a directory and open is true or false. Run nforge agent ROOT start --help.',
      );
      parameters = rest;
    }
    schema = hostedAgentCommandSchemas[action];
  }
  const parsed = schema.safeParse(parameters);
  invariant(
    parsed.success,
    'BAD_ARGUMENT',
    `Invalid ${requestedAction} parameters: ${parsed.success ? '' : parsed.error.issues.map(issue => `${issue.path.join('.') || 'parameters'}: ${issue.message}`).join('; ')}. Run nforge agent ROOT ${requestedAction} --help, correct the named fields and retry.`,
  );
  if (requestedAction === 'wait') {
    invariant(
      Boolean(input.runId) !== Boolean((input.operationIds as unknown[] | undefined)?.length),
      'BAD_ARGUMENT',
      'Choose one run or hosted landing operationIds. Run nforge agent ROOT wait --help.',
    );
  }
}
