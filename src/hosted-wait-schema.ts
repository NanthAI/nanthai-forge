// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/** The wait action's parameters. Apart from the observer so command validation never loads it. */
export const hostedWaitSchema = z
  .object({
    runId: z.uuid().optional(),
    operationIds: z.array(z.uuid()).optional(),
    cursor: z.string().nullable().optional(),
    until: z.enum(['terminal', 'any-change', 'acceptance']).optional(),
    timeoutSeconds: z.number().nonnegative().finite().optional(),
    /** Wait for a peer Lane (full id or 8+ character prefix) to land, fail or be cancelled, or close, or to post to you. Exclusive with runId and operationIds. */
    peer: z
      .string()
      .regex(/^[0-9a-fA-F]{8}[0-9a-fA-F-]{0,28}$/, 'a Lane id or 8+ character prefix')
      .optional(),
    /** Wait for the project owner to grant or decline this Lane's approval request (fe5bea80), or a held
     * settings change's request (its `setting:` id, Issue 470ef29b). Exclusive with the others. */
    approval: z
      .string()
      .regex(/^(?:[0-9a-f-]{36}|setting:[\w:-]{1,120})$/, 'a full Lane id or a setting: request id')
      .optional(),
  })
  .strict();
