// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
export const ownerLifecycleSchema = z
  .object({
    action: z.enum(['complete', 'reopen', 'abandon']),
    collection: z.enum(['lanes', 'intents']),
    id: z.uuid(),
    expectedHead: z.string().min(1),
    expectedState: z.string(),
    reason: z.string().default(''),
    saveFirst: z.boolean().default(false),
    cascade: z.boolean().default(false),
  })
  .strict();
export type OwnerLifecycle = z.infer<typeof ownerLifecycleSchema>;
