// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { landingMessageSchema } from './landing-message.js';
export const landSchema = z.object({
  action: z.literal('land'),
  preview: z.literal('skip').optional(),
  operationId: z.uuid().optional(),
  laneIds: z.array(z.uuid()).min(1),
  message: landingMessageSchema.optional(),
  channel: z.string().trim().min(1).default('main'),
  checkId: z.uuid().optional(),
  wait: z.boolean().optional(),
  waitMs: z.number().int().min(0).max(60000).optional(),
  keepOpen: z.boolean().optional(),
});
