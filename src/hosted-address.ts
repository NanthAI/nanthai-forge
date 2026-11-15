// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { deploymentUrl } from './deployment-origin.js';
export const deploymentOriginSchema = z.string().transform((value, ctx) => {
  try {
    return deploymentUrl(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Use a Forge deployment origin over HTTPS or HTTP loopback.' });
    return z.NEVER;
  }
});
export const hostedAgentAddressSchema = z
  .object({ url: deploymentOriginSchema, projectId: z.string().min(1) })
  .strict();
export type HostedAgentAddress = z.infer<typeof hostedAgentAddressSchema>;
