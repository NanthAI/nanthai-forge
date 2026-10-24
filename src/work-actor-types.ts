// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
export const workActorSchema = z.object({
  kind: z.enum(['person', 'agent']),
  name: z.string().min(1).max(200),
  tool: z.string().min(1).max(120).optional(),
});
export type WorkActor = z.infer<typeof workActorSchema>;
