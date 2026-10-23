// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
export const checkEnvironmentSchema = z.object({
  mode: z.literal('clean').optional(),
  platform: z.string(),
  arch: z.string(),
  os: z.string(),
  node: z.string(),
  env: z.record(z.string(), z.string()),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
