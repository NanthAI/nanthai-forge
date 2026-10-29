// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/** Additive run metadata. Selection and enforcement are supplied by the gate slice. */
export const checkGateSchema = z
  .object({
    mode: z.enum(['contract', 'scoped', 'audit', 'probe', 'full']),
    tests: z.array(z.string().min(1)).optional(),
    contractVersion: z.number().safe().nonnegative().optional(),
    reason: z.string().min(1).optional(),
    effective: z.enum(['contract', 'full', 'docs']).optional(),
  })
  .strict();
export const mainGateSchema = z
  .object({
    status: z.enum(['unknown', 'green', 'red']),
    unaudited: z
      .object({
        count: z.number().safe().nonnegative(),
        firstAt: z.iso.datetime().nullable(),
      })
      .strict(),
    debt: z.boolean(),
    hold: z.literal('main-red').nullable(),
  })
  .strict();
export type CheckGate = z.infer<typeof checkGateSchema>;
export type MainGate = z.infer<typeof mainGateSchema>;
