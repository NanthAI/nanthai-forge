// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
const page = {
  offset: z.number().int().nonnegative().safe().default(0),
  limit: z.number().int().positive().safe().default(20),
};
export const viewReadSchemas = [
  z.object({ action: z.literal('view'), viewId: z.string().uuid(), ...page }),
  z.object({
    action: z.literal('provenance'),
    viewId: z.string().uuid(),
    ...page,
    lines: z.boolean().default(false),
    file: z.string().optional(),
  }),
  z.object({ action: z.literal('views'), laneId: z.string().uuid(), ...page }),
] as const;
