// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

const environmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
/** References only. Credential values never enter policy, Work or source exports. */
export const modalCredentialsRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('env'), tokenId: environmentName, tokenSecret: environmentName }).strict(),
  z.object({ kind: z.literal('file'), path: z.string().min(1) }).strict(),
]);
export type ModalCredentialsRef = z.infer<typeof modalCredentialsRefSchema>;
