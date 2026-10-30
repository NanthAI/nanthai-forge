// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

const environmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
/** Read compatibility only for persisted retired-runner policies and receipts. Never resolved. */
export const legacyCheckCredentialsRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('env'), tokenId: environmentName, tokenSecret: environmentName }).strict(),
  z.object({ kind: z.literal('file'), path: z.string().min(1) }).strict(),
]);
export type LegacyCheckCredentialsRef = z.infer<typeof legacyCheckCredentialsRefSchema>;
