// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';
/** One operator setting; optional device-start override; the approved default is 120/minute. */
export function publicAbuseBudgets() {
  const value = process.env.FORGE_PUBLIC_ABUSE_BUDGETS;
  if (!value) return null;
  return z
    .object({
      deviceStartsPerMinute: z.number().int().positive().safe(),
    })
    .strict()
    .parse(JSON.parse(value));
}
