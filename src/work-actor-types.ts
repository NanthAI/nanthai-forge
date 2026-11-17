// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { AGENT_CLIENT, AGENT_STAMP_VALUE } from './agent-slug.js';
export const workActorSchema = z.object({
  kind: z.enum(['person', 'agent']),
  name: z.string().min(1).max(200),
  tool: z.string().min(1).max(120).optional(),
});
export type WorkActor = z.infer<typeof workActorSchema>;

/** Attribution is a declaration, never authority. The same byte-preserving rule is used by
 * FORGE_AGENT_MODEL; parsed metadata must never differ from immutable stored bytes. */
const stampText = z.string().regex(AGENT_STAMP_VALUE);
export const authorshipClaimSchema = z
  .object({
    kind: z.enum(['agent', 'person']),
    // Only a missing-model state; app/model/run stay in agentClient and agentRun.
    declaration: z.enum(['unknown', 'not-declared']).optional(),
  })
  .strict()
  .refine(
    value => value.kind === 'agent' || value.declaration === undefined,
    'A person stamp has no agent model declaration.',
  );
export type AuthorshipClaim = z.infer<typeof authorshipClaimSchema>;
/** Project only the source declaration; account identity stays in the record's existing actor. */
export function sourceAuthorship(value: {
  authorship?: AuthorshipClaim | undefined;
  agentClient?: string | undefined;
  agentRun?: string | undefined;
}) {
  return value.authorship
    ? {
        authorship: value.authorship,
        ...(value.agentClient ? { agentClient: value.agentClient } : {}),
        ...(value.agentRun ? { agentRun: value.agentRun } : {}),
      }
    : {};
}
/** Receipt builders can differ from the approving actor. Lanes/saves use their existing actor. */
export const authorshipSchema = authorshipClaimSchema.safeExtend({ actor: stampText });
export const authorshipFields = {
  authorship: authorshipClaimSchema.optional(),
  agentClient: z.string().regex(AGENT_CLIENT).optional(),
  agentRun: stampText.optional(),
};
export function personStampValid(value: {
  authorship?: { kind: string } | undefined;
  agentClient?: string | undefined;
  agentRun?: string | undefined;
}) {
  return (
    value.authorship?.kind !== 'person' || (value.agentClient === undefined && value.agentRun === undefined)
  );
}
/** Labels can change on retry; the original source request and its retained stamp cannot. */
export function withoutAuthorship<
  T extends { authorship?: unknown; agentClient?: unknown; agentRun?: unknown },
>(value: T) {
  const { authorship, agentClient, agentRun, ...semantic } = value;
  void authorship;
  void agentClient;
  void agentRun;
  return semantic;
}

/** One read mapping for modern and legacy records. A declared agentClient model always wins
 * over a missing-model marker; no reader invents a declaration from the approving actor. */
export function readAuthorship(value: {
  authorship?:
    | {
        kind: 'agent' | 'person';
        declaration?: 'unknown' | 'not-declared' | undefined;
        actor?: string | undefined;
      }
    | undefined;
  agentClient?: string | undefined;
  agentRun?: string | undefined;
  actor?: string | { id: string; kind: 'agent' | 'person' } | undefined;
}) {
  const client =
    value.agentClient && AGENT_CLIENT.test(value.agentClient) ? value.agentClient.split(':') : undefined;
  const kind =
    value.authorship?.kind ??
    (client || value.agentRun ? 'agent' : typeof value.actor === 'object' ? value.actor.kind : undefined);
  return {
    kind,
    actor: value.authorship?.actor ?? (typeof value.actor === 'string' ? value.actor : value.actor?.id),
    app: client?.[0] === 'agent' ? undefined : client?.[0],
    model: kind === 'person' ? null : (client?.[1] ?? value.authorship?.declaration ?? 'not-declared'),
    agentRun: value.agentRun,
  };
}
