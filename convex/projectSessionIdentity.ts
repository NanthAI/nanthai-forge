// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { z } from 'zod';
import type { Doc } from './_generated/dataModel';
import type { sessionClaimSchema } from '../src/hosted-lane';
/** A label is client-reported; the device binding comes only from the current authenticated row. */
export function sessionIdentity(
  sessionId: string,
  claim: z.infer<typeof sessionClaimSchema> | undefined,
  startedAt: number,
  credential?: Doc<'cliCredentials'> | null,
) {
  return {
    sessionId,
    startedAt,
    ...claim,
    ...(credential?.deviceCode && credential.deviceApprovedAt !== undefined
      ? {
          device: {
            id: credential.credentialId,
            code: credential.deviceCode,
            approvedAt: credential.deviceApprovedAt,
            owner: credential.owner,
          },
        }
      : {}),
  };
}
