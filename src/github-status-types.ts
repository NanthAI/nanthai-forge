// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
/** Local observations update cockpit metadata, never source objects or check evidence. */
export const githubStatusSchema = z
  .object({
    ownerId: z.uuid(),
    revision: z.number().int().nonnegative(),
    entries: z
      .array(
        z
          .object({
            collection: z.enum(['githubSync', 'githubAutoPush']),
            key: z.string().min(1),
            parent: z.string(),
            value: z.record(z.string(), z.unknown()),
          })
          .strict(),
      )
      .max(2),
  })
  .strict();
