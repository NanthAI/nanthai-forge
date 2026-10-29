// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { checkPin, type HostedCheckRun } from './hosted-check.js';

export const mainAuditSettingsSchema = z
  .object({
    landings: z.number().safe().positive().default(10),
    minutes: z
      .number()
      .finite()
      .positive()
      .default(24 * 60),
  })
  .strict();
export const defaultMainAuditSettings = mainAuditSettingsSchema.parse({});
export const mainAuditStallMs = 15 * 60_000;
export type MainAuditSettings = z.infer<typeof mainAuditSettingsSchema>;
export function auditDebt(
  count: number,
  firstAt: string | null,
  settings = defaultMainAuditSettings,
  now = Date.now(),
) {
  return (
    count >= 2 * settings.landings ||
    (count > 0 && firstAt !== null && now - Date.parse(firstAt) >= 2 * settings.minutes * 60_000)
  );
}
export function auditDue(
  count: number,
  firstAt: string | null,
  settings = defaultMainAuditSettings,
  now = Date.now(),
) {
  return count >= settings.landings ? now : Date.parse(firstAt!) + settings.minutes * 60_000;
}
/** Q3 content identity excludes Candidate/operation IDs: identical source and execution inputs reuse evidence. */
export const mainAuditKey = (input: {
  projectId: string;
  head: string;
  definition: string;
  configuration: string;
  environment: string;
  authorityEpoch: number;
}) => checkPin(input);
export function auditOperationId(key: string, attempt = 0) {
  const hash = checkPin({ kind: 'hosted-main-audit', key, attempt });
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
const metadataSchema = z
  .object({
    sequence: z.number().safe().nonnegative(),
    count: z.number().safe().nonnegative(),
    attempt: z.union([z.literal(0), z.literal(1)]),
    key: z.string(),
    firstAt: z.iso.datetime().optional(),
  })
  .strict();
/** The S0 run format already has a durable reason field; keep the audit's coverage pinned with its run. */
export const auditReason = (metadata: z.infer<typeof metadataSchema>) =>
  `Main audit ${JSON.stringify(metadataSchema.parse(metadata))}`;
export const auditMetadata = (run: HostedCheckRun) =>
  metadataSchema.parse(JSON.parse(run.gate!.reason!.slice('Main audit '.length)));
export function fullGate(run: HostedCheckRun) {
  return run.gate?.effective === 'full' || run.gate?.mode === 'full' || !run.gate;
}
export const docsGate = (run: HostedCheckRun) => run.gate?.effective === 'docs';
