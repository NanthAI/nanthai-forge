// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
export const hostedAgentAddressSchema = z.object({ url: z.url(), projectId: z.string().min(1) }).strict();
export type HostedAgentAddress = z.infer<typeof hostedAgentAddressSchema>;
