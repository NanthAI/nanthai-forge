// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { checkEnvironmentSchema } from './check-environment-schema.js';

export const landingRuntimeSchema = z.object({
  nodeExecutable: z.string(),
  nodeBinary: z.string().optional(),
  cli: z.string(),
});
export const landingPinsSchema = z.object({
  environment: checkEnvironmentSchema,
  runtime: landingRuntimeSchema,
});
export type LandingPins = z.infer<typeof landingPinsSchema>;
