// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

const detail = {
  paths: z.array(z.string()).max(10),
  more: z.number().int().nonnegative(),
  at: z.iso.datetime(),
  next: z.string(),
};
/** One existing advice channel: accepted-main overlap or a proven merge
 * conflict on an unaccepted predecessor. Neither variant settles a request. */
export const wouldConflictSchema = z.union([
  z.object({ ...detail, landedSubmissionId: z.string() }).strict(),
  z
    .object({
      ...detail,
      code: z.literal('COMPOSITION_CONFLICT'),
      predecessor: z
        .object({
          groupId: z.uuid(),
          submissionId: z.uuid(),
          head: z.string().regex(/^[0-9a-f]{64}$/),
          receiptId: z.uuid(),
        })
        .strict(),
    })
    .strict(),
]);
export type WouldConflict = z.infer<typeof wouldConflictSchema>;
