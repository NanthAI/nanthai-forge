// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/** Policy shape for B2.6 trust per path per actor. Absent means off; `enabled:false` records history
 * (shadow mode) without changing any gate. Kept free of imports from autonomy-policy.ts to avoid a cycle. */
export const trustLevelSchema = z.enum(['supervised', 'trusted', 'autonomous']);
export type TrustLevel = z.infer<typeof trustLevelSchema>;
export const trustConfigSchema = z
  .object({
    enabled: z.boolean(),
    /** Weighted green-landing points on one area (decayed) to reach `trusted`. */
    trustedAt: z.number().positive().finite().optional(),
    autonomousAt: z.number().positive().finite().optional(),
    halfLifeDays: z.number().positive().finite().optional(),
    /** Fraction of an area's score kept after a culprit finding there. */
    culpritKeep: z.number().min(0).max(1).optional(),
    /** Green landings a new vendor needs overall before any area leaves supervised. */
    probationLandings: z.number().int().nonnegative().optional(),
    /** Owner-declared vendor label per actor id; an unlisted actor is its own vendor. */
    vendors: z.record(z.string().min(1), z.string().min(1)).optional(),
    /** Vendors the owner already trusts; their new actors skip probation. */
    establishedVendors: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type TrustConfig = z.infer<typeof trustConfigSchema>;
