// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { hostedAgentAction, hostedAgentCommandSchemas } from './hosted-agent-contract.js';
import { hostedClientReadSchemas } from './hosted-agent-reads.js';
import { unknownActionError } from './hosted-agent-version.js';
import { ForgeError, invariant } from './errors.js';
import { describeIssues } from './argument-errors.js';
import { actionRoot } from './agent-verbs.js';
import { planningIssueArguments } from './planning-issue-arguments.js';

/** The same enforced schemas, before installed-CLI release discovery. Only
 * argument validation happens here; dispatch retains authority and retry checks. */
export function validateHostedCliCommand(
  root: string,
  requestedAction: string,
  selected: Record<string, unknown>,
) {
  const input = planningIssueArguments(
    requestedAction,
    Object.fromEntries(
      Object.entries(selected).filter(([key]) => !['url', 'projectId', 'action'].includes(key)),
    ),
  );
  const local: Record<string, z.ZodType> = hostedClientReadSchemas;
  let schema: z.ZodType;
  let parameters = input;
  if (Object.hasOwn(local, requestedAction)) {
    schema = local[requestedAction]!;
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
        `operationId: expected a UUID. Run ${actionRoot(requestedAction)} ${requestedAction} --help and retry.`,
      );
      parameters = rest;
    }
    if (action === 'start') {
      const { path, open, installScripts, ...rest } = parameters;
      invariant(
        (path === undefined || (typeof path === 'string' && path !== '')) &&
          (open === undefined || typeof open === 'boolean') &&
          (installScripts === undefined || typeof installScripts === 'boolean'),
        'BAD_ARGUMENT',
        'start path is a directory, open is true or false, and installScripts is true or false. Run nforge agent ROOT start --help.',
      );
      parameters = rest;
    }
    schema = hostedAgentCommandSchemas[action];
  }
  const parsed = schema.safeParse(parameters);
  invariant(
    parsed.success,
    'BAD_ARGUMENT',
    `Invalid ${requestedAction} parameters: ${parsed.success ? '' : describeIssues(parsed.error.issues, parameters)}. Run ${actionRoot(requestedAction)} ${requestedAction} --help, correct the named fields and retry.`,
  );
  // A bare start has nothing to start (Issue ec7bd1b5): refused before any call, as dispatch does.
  if (requestedAction === 'start') {
    const asked = parsed.data as { planningItemId?: string; intentId?: string; outcome?: string };
    invariant(
      asked.planningItemId || asked.intentId || asked.outcome,
      'BAD_ARGUMENT',
      'start needs one of: planningItemId (an Issue id), intentId (join an Intent), or outcome (a new one).',
    );
  }
  if (requestedAction === 'wait') {
    invariant(
      [input.runId, (input.operationIds as unknown[] | undefined)?.length, input.peer, input.approval].filter(
        Boolean,
      ).length === 1,
      'BAD_ARGUMENT',
      'Choose exactly one of runId, operationIds, peer or approval. Run nforge agent ROOT wait --help.',
    );
  }
}
