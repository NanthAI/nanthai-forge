import { hostedActionError } from './hosted-action-error.js';
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { ForgeError, invariant } from './errors.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';
export const liveLanesInput = z
  .object({
    cursor: z.string().startsWith('forge-lanes-v1:').nullable().default(null),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export async function liveLanes(transport: HostedAgentTransport, input: Record<string, unknown>) {
  const parsed = liveLanesInput.safeParse(input);
  invariant(
    parsed.success,
    'BAD_ARGUMENT',
    `Invalid lanes parameters: ${parsed.success ? '' : parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}. Run nforge agent ROOT lanes --help and retry with the returned cursor and a page size from 1 to 100.`,
  );
  try {
    return {
      schema: 1 as const,
      transport: 'hosted' as const,
      action: 'lanes' as const,
      operationId: null,
      resolved: null,
      result: await transport.query('projectHostedLiveLanes:list', parsed.data),
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
        'This deployment does not offer the live Lane list. Deploy the matching projectHostedLiveLanes API, then rerun nforge agent ROOT lanes {}.',
      );
    const failure = hostedActionError(error, 'live Lane read');
    if (failure.code === 'HOSTED_ACTION_FAILED')
      throw new ForgeError(
        failure.code,
        'The live Lane read failed. Rerun nforge agent ROOT lanes with the original cursor to retry this page; if it persists, inspect the deployment query logs.',
      );
    if (failure.code === 'PROJECT_UNAVAILABLE')
      throw new ForgeError(
        failure.code,
        `${failure.message} Run nforge login for an account with project access, then rerun nforge agent ROOT lanes with the original cursor.`,
      );
    throw failure;
  }
}
