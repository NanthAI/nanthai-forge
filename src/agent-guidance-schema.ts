// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
export const guidanceInputSchema = z.object({
  operationId: z.string().uuid(),
  scope: z.enum(['project', 'personal']),
  agentGuidance: z.string().max(4000),
});
