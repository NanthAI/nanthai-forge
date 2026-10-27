// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/** References only. Forge never opens or uploads the agent's transcript. */
export const conversationSchema = z.object({
  agent: z.enum(['claude-code', 'codex', 'generic']),
  sessionId: z.string().min(1).max(200),
  turnId: z.string().min(1).max(200),
  link: z.string().min(1).max(2048).optional(),
});
export type Conversation = z.infer<typeof conversationSchema>;
export const overlapAnswerSchema = z.object({
  laneId: z.uuid(),
  noticeId: z.string().regex(/^[a-f0-9]{64}$/),
  deliveryId: z.string().min(1),
  disposition: z.enum(['acknowledged', 'routed-around']),
});
