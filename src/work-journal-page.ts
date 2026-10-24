// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { hostedEventSchema } from './work-types.js';
import { hostedIntentMigrationSchema } from './work-hosted-intents.js';
export const journalHeaderSchema = z.object({
  projectKey: z.uuid(),
  name: z.string(),
  backupId: z.string(),
  archiveSha256: z.string().regex(/^[0-9a-f]{64}$/),
  manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
  initialRevision: z.number().safe().nonnegative(),
  revision: z.number().safe().nonnegative(),
  head: z.string(),
  intentMigration: hostedIntentMigrationSchema.optional(),
});
export const journalPageSchema = z.object({
  header: journalHeaderSchema,
  snapshot: z.string(),
  previousEventSha256: z.string().nullable(),
  events: z.array(hostedEventSchema),
  nextRevision: z.number().safe().nonnegative(),
  isDone: z.boolean(),
});
export type JournalPage = z.infer<typeof journalPageSchema>;
